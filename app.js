const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const { PassThrough } = require('stream');

// Environment-based FFmpeg paths with validation
const FFMPEG_PATH = process.env.FFMPEG_PATH || '/usr/bin/ffmpeg';
const FFPROBE_PATH = process.env.FFPROBE_PATH || '/usr/bin/ffprobe';

// Validate FFmpeg paths on startup
(async () => {
  try {
    await fs.access(FFMPEG_PATH);
    await fs.access(FFPROBE_PATH);
    ffmpeg.setFfmpegPath(FFMPEG_PATH);
    ffmpeg.setFfprobePath(FFPROBE_PATH);
    console.log('✅ FFmpeg paths validated');
  } catch (err) {
    console.error('❌ FFmpeg/ffprobe not found:', err.message);
    process.exit(1);
  }
})();

const app = express();

// Koyeb uses PORT environment variable automatically
const PORT = process.env.PORT || 8000;

// Video file paths
const VIDEO_FILES = {
  's.mp4': '/app/s.mp4',
  'video.mp4': '/app/video.mp4'
};
const DEFAULT_VIDEO = 's.mp4';

// Fixed quality settings
const WIDTH = 160;
const HEIGHT = 120;
const FPS = 10;
const PRESET = 'ultrafast';
const FRAME_INTERVAL = 1000 / FPS;
const TIMEOUT_MS = 8000;
const MAX_RETRIES = 3;
const MAX_CONCURRENT_FFMPEG = 5;
const MEMORY_THRESHOLD = 200 * 1024 * 1024;
const STALE_INSTANCE_THRESHOLD = 60000; // 60 seconds
const MAX_CONSECUTIVE_ERRORS = 5;

// Video state
let videoStartTime = Date.now();
let videoDurations = {};
let lastPixels = [];
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let totalErrors = 0;
let lastProcessingTimes = [];
let activeFFmpegCount = 0;
let performanceStats = {
  avgProcessingTime: 0,
  successRate: 0,
  lastSuccessTime: 0,
  memoryUsage: null
};

// Enhanced active instances tracking
const activeInstances = new Map();
let instanceCounter = 0;
const generateInstanceId = () => ++instanceCounter;

// Promise-based processing queue to prevent race conditions
let processingQueue = Promise.resolve();
let isProcessing = false;

// Logging utility (simple level-based logging)
const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const LOG_LEVELS = { error: 0, warn: 1, info: 2, debug: 3 };

const log = (level, message, ...args) => {
  if (LOG_LEVELS[level] <= LOG_LEVELS[LOG_LEVEL]) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level.toUpperCase()}]`, message, ...args);
  }
};

// Enhanced process killer with verification
const killProcess = async (pid, signal = 'SIGTERM') => {
  if (!pid) return true;
  
  try {
    process.kill(pid, signal);
    log('info', `Sent ${signal} to process ${pid}`);
    
    // Verify process termination (simple check)
    setTimeout(() => {
      try {
        process.kill(pid, 0); // Check if process exists
        log('warn', `Process ${pid} still exists after ${signal}`);
      } catch (err) {
        if (err.code === 'ESRCH') {
          log('info', `Process ${pid} successfully terminated`);
        }
      }
    }, 1000);
    
    return true;
  } catch (err) {
    if (err.code === 'ESRCH') {
      log('debug', `Process ${pid} already terminated`);
      return true;
    }
    log('error', `Failed to kill process ${pid} with ${signal}:`, err.message);
    return false;
  }
};

// Timeout wrapper for promises
const withTimeout = (promise, ms, errorMessage = 'Operation timed out') => {
  const timeoutPromise = new Promise((_, reject) => 
    setTimeout(() => reject(new Error(errorMessage)), ms)
  );
  return Promise.race([promise, timeoutPromise]);
};

// Validate and get video duration with timeout
async function getVideoDuration(videoPath) {
  try {
    // Add timeout for file access
    await withTimeout(fs.access(videoPath), 5000, 'File access timeout');
    
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new Error('ffprobe timeout'));
      }, 10000);

      ffmpeg.ffprobe(videoPath, (err, metadata) => {
        clearTimeout(timeout);
        if (err) {
          log('warn', `ffprobe failed for ${videoPath}:`, err.message);
          resolve(300);
        } else {
          const duration = metadata.format.duration || 300;
          log('info', `Video duration for ${videoPath}: ${duration}s`);
          resolve(duration);
        }
      });
    });
  } catch (err) {
    log('error', `Video file access error: ${videoPath}`, err.message);
    return 300;
  }
}

// Initialize video durations with validation
(async () => {
  try {
    let hasValidVideo = false;
    
    for (const [videoName, videoPath] of Object.entries(VIDEO_FILES)) {
      try {
        await fs.access(videoPath);
        videoDurations[videoName] = await getVideoDuration(videoPath);
        hasValidVideo = true;
        log('info', `Video ${videoName} initialized: ${videoDurations[videoName]}s`);
      } catch (err) {
        log('warn', `Video file ${videoName} not found at ${videoPath}`);
        videoDurations[videoName] = 300;
      }
    }
    
    if (!hasValidVideo) {
      log('error', 'No valid video files found');
      process.exit(1);
    }
    
    log('info', 'Videos initialized:', videoDurations);
  } catch (err) {
    log('error', 'Failed to initialize videos:', err.message);
    process.exit(1);
  }
})();

// Periodic cleanup of stale instances
setInterval(() => {
  const now = Date.now();
  let cleanedCount = 0;
  
  for (const [instanceId, instanceInfo] of activeInstances) {
    if (now - instanceInfo.startTime > STALE_INSTANCE_THRESHOLD) {
      log('info', `Cleaning up stale instance ${instanceId}`);
      const { processId } = instanceInfo;
      if (processId) {
        killProcess(processId, 'SIGKILL');
      }
      activeInstances.delete(instanceId);
      cleanedCount++;
    }
  }
  
  if (cleanedCount > 0) {
    log('info', `Cleaned up ${cleanedCount} stale instances`);
  }
}, 30000); // Run every 30 seconds

// Enhanced cleanup function
const createCleanupFunction = (instanceId) => {
  let isCleanedUp = false;
  let timeoutHandle = null;
  let outputStream = null;
  let cleanupTimeout = null;

  const cleanup = (reason = 'unknown') => {
    if (isCleanedUp) return;
    isCleanedUp = true;

    log('debug', `Cleanup triggered for instance ${instanceId}: ${reason}`);

    // Clear timeouts
    if (cleanupTimeout) {
      clearTimeout(cleanupTimeout);
      cleanupTimeout = null;
    }
    if (timeoutHandle) {
      clearTimeout(timeoutHandle);
      timeoutHandle = null;
    }

    // Destroy output stream
    if (outputStream && !outputStream.destroyed) {
      try {
        outputStream.removeAllListeners();
        outputStream.destroy();
        log('debug', `Stream destroyed for instance ${instanceId}`);
      } catch (err) {
        log('error', `Error destroying stream for instance ${instanceId}:`, err.message);
      }
      outputStream = null;
    }

    // Handle FFmpeg instance cleanup
    const instanceInfo = activeInstances.get(instanceId);
    if (instanceInfo) {
      const { ffmpegInstance, processId } = instanceInfo;
      
      instanceInfo.status = 'cleaning_up';
      
      try {
        // Graceful termination
        if (ffmpegInstance && typeof ffmpegInstance.kill === 'function') {
          ffmpegInstance.kill('SIGTERM');
          log('debug', `Sent SIGTERM via fluent-ffmpeg to instance ${instanceId}`);
        }
        
        if (processId) {
          killProcess(processId, 'SIGTERM');
          
          // Escalate after delay
          cleanupTimeout = setTimeout(() => {
            killProcess(processId, 'SIGKILL');
          }, 2000);
        }
      } catch (err) {
        log('error', `Error during cleanup for instance ${instanceId}:`, err.message);
      }
      
      // Remove from tracking after delay
      setTimeout(() => {
        activeInstances.delete(instanceId);
        log('debug', `Removed instance ${instanceId} from tracking`);
      }, 3000);
    }
  };

  return {
    cleanup,
    isCleanedUp: () => isCleanedUp,
    setTimeoutHandle: (h) => (timeoutHandle = h),
    setOutputStream: (s) => (outputStream = s)
  };
};

// Enhanced frame processing with concurrency control
const processSingleFrame = async (targetTime, videoName, retryCount = 0) => {
  // Check concurrency limit
  if (activeFFmpegCount >= MAX_CONCURRENT_FFMPEG) {
    log('warn', `Max FFmpeg instances reached (${activeFFmpegCount})`);
    return null;
  }

  activeFFmpegCount++;
  const instanceId = generateInstanceId();

  try {
    return await processSingleFrameLogic(targetTime, videoName, retryCount, instanceId);
  } finally {
    activeFFmpegCount--;
  }
};

const processSingleFrameLogic = async (targetTime, videoName, retryCount, instanceId) => {
  const videoPath = VIDEO_FILES[videoName] || VIDEO_FILES[DEFAULT_VIDEO];
  
  return new Promise((resolve) => {
    log('debug', `Processing frame at ${targetTime.toFixed(2)}s (${videoName}) - Instance ${instanceId} - Attempt ${retryCount + 1}`);
    const startTime = Date.now();
    const chunks = [];

    const cleanupManager = createCleanupFunction(instanceId);
    const outputStream = new PassThrough();
    cleanupManager.setOutputStream(outputStream);

    const streamTimeout = setTimeout(() => {
      if (!cleanupManager.isCleanedUp()) {
        log('warn', `Frame timeout at ${targetTime.toFixed(2)}s (${TIMEOUT_MS}ms) - Instance ${instanceId}`);
        cleanupManager.cleanup('timeout');

        if (retryCount < MAX_RETRIES) {
          setTimeout(() => {
            processSingleFrame(targetTime, videoName, retryCount + 1).then(resolve);
          }, 1000);
        } else {
          resolve(null);
        }
      }
    }, TIMEOUT_MS);

    cleanupManager.setTimeoutHandle(streamTimeout);

    // Process in async context
    (async () => {
      try {
        await fs.access(videoPath);

        // Collect chunks efficiently
        outputStream.on('data', (chunk) => {
          if (!cleanupManager.isCleanedUp()) {
            chunks.push(chunk);
          }
        });

        outputStream.on('end', () => {
          if (cleanupManager.isCleanedUp()) return;

          const processingTime = Date.now() - startTime;
          
          try {
            const pixelBuffer = Buffer.concat(chunks);
            const expectedSize = WIDTH * HEIGHT * 3;

            if (pixelBuffer.length === 0) {
              log('warn', `Empty buffer received for frame at ${targetTime.toFixed(2)}s - Instance ${instanceId}`);
              cleanupManager.cleanup('empty_buffer');
              resolve(null);
              return;
            }

            if (pixelBuffer.length !== expectedSize) {
              log('warn', `Buffer size mismatch - Instance ${instanceId}: got ${pixelBuffer.length}, expected ${expectedSize}`);
              
              if (pixelBuffer.length >= expectedSize * 0.9) {
                const truncatedBuffer = pixelBuffer.slice(0, expectedSize);
                log('debug', `Using truncated buffer - Instance ${instanceId}`);
                
                const pixels = [];
                for (let i = 0; i < truncatedBuffer.length; i += 3) {
                  if (i + 2 < truncatedBuffer.length) {
                    pixels.push([truncatedBuffer[i], truncatedBuffer[i + 1], truncatedBuffer[i + 2]]);
                  }
                }
                
                log('info', `Frame at ${targetTime.toFixed(2)}s: ${pixels.length} pixels (${processingTime}ms) - Instance ${instanceId}`);
                cleanupManager.cleanup('success');
                resolve(pixels);
                return;
              } else {
                cleanupManager.cleanup('buffer_size_mismatch');
                resolve(null);
                return;
              }
            }

            const pixels = [];
            for (let i = 0; i < pixelBuffer.length; i += 3) {
              if (i + 2 < pixelBuffer.length) {
                pixels.push([pixelBuffer[i], pixelBuffer[i + 1], pixelBuffer[i + 2]]);
              }
            }

            log('info', `Frame at ${targetTime.toFixed(2)}s: ${pixels.length} pixels (${processingTime}ms) - Instance ${instanceId}`);
            lastProcessingTimes.push(processingTime);
            if (lastProcessingTimes.length > 10) lastProcessingTimes.shift();
            
            cleanupManager.cleanup('success');
            resolve(pixels);
            
          } catch (err) {
            log('error', `Pixel processing error - Instance ${instanceId}:`, err.message);
            cleanupManager.cleanup('pixel_processing_error');
            resolve(null);
          }
        });

        outputStream.on('error', (err) => {
          if (cleanupManager.isCleanedUp()) return;
          cleanupManager.cleanup('stream_error');
          log('error', `Stream error at ${targetTime.toFixed(2)}s - Instance ${instanceId}:`, err.message);

          // Retry logic with non-retryable error check
          if (retryCount < MAX_RETRIES && !err.message.includes('No such file')) {
            setTimeout(() => {
              processSingleFrame(targetTime, videoName, retryCount + 1).then(resolve);
            }, 1000);
          } else {
            resolve(null);
          }
        });

        // Create FFmpeg instance with simplified, reliable options
        const ffmpegInstance = ffmpeg(videoPath)
          .inputOptions([
            `-ss ${Math.max(0, targetTime)}`,
            '-accurate_seek'
          ])
          .videoFilters([
            `scale=${WIDTH}:${HEIGHT}`,
            'format=rgb24'
          ])
          .outputOptions([
            '-f rawvideo',
            '-pix_fmt rgb24',
            `-preset ${PRESET}`,
            '-threads 0', // Auto-detect CPU cores
            '-vframes 1'
          ])
          .on('start', (cmd) => {
            log('debug', `FFmpeg started - Instance ${instanceId}`);
          })
          .on('error', (err) => {
            if (cleanupManager.isCleanedUp()) return;
            
            log('error', `FFmpeg error at ${targetTime.toFixed(2)}s - Instance ${instanceId}:`, err.message);
            cleanupManager.cleanup('ffmpeg_error');

            // Differentiate retryable errors
            const isRetryable = !err.message.includes('No such file') && 
                               !err.message.includes('Invalid data');

            if (retryCount < MAX_RETRIES && isRetryable) {
              setTimeout(() => {
                processSingleFrame(targetTime, videoName, retryCount + 1).then(resolve);
              }, 1000);
            } else {
              resolve(null);
            }
          });

        // Capture process ID for cleanup
        let processId = null;
        const originalSpawn = ffmpegInstance._spawn;
        ffmpegInstance._spawn = function(...args) {
          const result = originalSpawn.apply(this, args);
          if (result && result.pid) {
            processId = result.pid;
            const instanceInfo = activeInstances.get(instanceId);
            if (instanceInfo) {
              instanceInfo.processId = processId;
            }
          }
          return result;
        };

        // Store instance information
        activeInstances.set(instanceId, {
          ffmpegInstance,
          processId,
          startTime: Date.now(),
          status: 'starting',
          targetTime
        });

        // Start the FFmpeg process
        try {
          ffmpegInstance.pipe(outputStream, { end: true });
          
          const instanceInfo = activeInstances.get(instanceId);
          if (instanceInfo) {
            instanceInfo.status = 'running';
          }
        } catch (pipeError) {
          log('error', `Pipe error - Instance ${instanceId}:`, pipeError.message);
          cleanupManager.cleanup('pipe_error');
          resolve(null);
        }

      } catch (err) {
        log('error', `General error - Instance ${instanceId}:`, err.message);
        cleanupManager.cleanup('general_error');
        resolve(null);
      }
    })();
  });
};

// Enhanced processing loop with queue-based concurrency control
const processFrameLoop = async () => {
  if (!videoDurations[DEFAULT_VIDEO]) return;

  // Add to processing queue to prevent race conditions
  processingQueue = processingQueue.then(async () => {
    if (isProcessing) return;

    // Memory monitoring with enhanced handling
    performanceStats.memoryUsage = process.memoryUsage();
    if (performanceStats.memoryUsage.heapUsed > MEMORY_THRESHOLD) {
      log('warn', `High memory usage: ${Math.round(performanceStats.memoryUsage.heapUsed / 1024 / 1024)}MB`);
      
      // Clean up stale instances
      const now = Date.now();
      for (const [instanceId, instanceInfo] of activeInstances) {
        if (now - instanceInfo.startTime > 30000) {
          log('info', `Force cleaning stale instance ${instanceId}`);
          const { processId } = instanceInfo;
          if (processId) killProcess(processId, 'SIGKILL');
          activeInstances.delete(instanceId);
        }
      }

      if (global.gc) {
        global.gc();
        log('info', 'Triggered garbage collection');
      } else {
        log('warn', 'Garbage collection not available; run Node with --expose-gc');
      }
      
      await new Promise(resolve => setTimeout(resolve, 5000));
      return;
    }

    // Error management
    if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
      consecutiveErrors = Math.floor(consecutiveErrors * 0.8);
      log('warn', `Pausing for 10s due to errors (count: ${consecutiveErrors})`);
      await new Promise(resolve => setTimeout(resolve, 10000));
      return;
    }

    isProcessing = true;
    
    try {
      // Use frame-based calculation for better precision
      const currentFrame = Math.floor((Date.now() - videoStartTime) / 1000 * FPS) % (videoDurations[DEFAULT_VIDEO] * FPS);
      const currentTime = currentFrame / FPS;

      const pixels = await processSingleFrame(currentTime, DEFAULT_VIDEO);

      if (pixels && pixels.length > 0) {
        lastPixels = pixels;
        consecutiveErrors = Math.max(0, consecutiveErrors - 1);
        totalFramesProcessed++;
        performanceStats.lastSuccessTime = Date.now();
        performanceStats.successRate = totalFramesProcessed / (totalFramesProcessed + totalErrors);

        if (lastProcessingTimes.length > 0) {
          performanceStats.avgProcessingTime = lastProcessingTimes.reduce((a, b) => a + b, 0) / lastProcessingTimes.length;
        }
      } else {
        consecutiveErrors++;
        totalErrors++;
        log('warn', `Failed frame (${consecutiveErrors} consecutive errors, ${activeInstances.size} active)`);
      }

    } catch (error) {
      log('error', 'Unexpected error in processing loop:', error.message);
      consecutiveErrors++;
      totalErrors++;
    } finally {
      isProcessing = false;
    }
  }).catch(err => {
    log('error', 'Processing queue error:', err.message);
    isProcessing = false;
  });
};

const processingInterval = setInterval(processFrameLoop, FRAME_INTERVAL);

// Enhanced graceful shutdown
const gracefulShutdown = async (signal) => {
  log('info', `Received ${signal}, cleaning up ${activeInstances.size} active instances...`);
  
  clearInterval(processingInterval);
  
  const cleanupPromises = [];
  
  for (const [instanceId, instanceInfo] of activeInstances) {
    const { ffmpegInstance, processId } = instanceInfo;
    
    const cleanupPromise = new Promise((resolve) => {
      try {
        if (ffmpegInstance && typeof ffmpegInstance.kill === 'function') {
          ffmpegInstance.kill('SIGTERM');
        }
        
        if (processId) {
          killProcess(processId, 'SIGTERM');
        }

        setTimeout(() => {
          if (processId) {
            killProcess(processId, 'SIGKILL');
          }
          resolve();
        }, 2000);
        
      } catch (e) {
        log('error', `Error during graceful shutdown for instance ${instanceId}:`, e.message);
        resolve();
      }
    });

    cleanupPromises.push(cleanupPromise);
  }

  try {
    await Promise.all(cleanupPromises);
    activeInstances.clear();
    log('info', 'All instances cleaned up');
    process.exit(0);
  } catch (err) {
    log('error', 'Some cleanup operations failed, forcing exit');
    process.exit(1);
  }
};

// Enhanced CORS with origin validation
const ALLOWED_ORIGINS = process.env.ALLOWED_ORIGINS ? 
  process.env.ALLOWED_ORIGINS.split(',') : ['*'];

app.use((req, res, next) => {
  const origin = req.headers.origin;
  
  if (ALLOWED_ORIGINS.includes('*') || ALLOWED_ORIGINS.includes(origin)) {
    res.header('Access-Control-Allow-Origin', ALLOWED_ORIGINS.includes('*') ? '*' : origin);
  }
  
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

app.use((req, res, next) => {
  log('info', `${req.method} ${req.path} - ${req.ip} (${activeInstances.size} active)`);
  next();
});

// Enhanced API endpoints with validation
app.get('/frame', async (req, res) => {
  try {
    const videoName = req.query.video || DEFAULT_VIDEO;
    
    // Validate video name
    if (!VIDEO_FILES[videoName]) {
      return res.status(400).json({ 
        error: `Invalid video name: ${videoName}`,
        availableVideos: Object.keys(VIDEO_FILES)
      });
    }
    
    const videoDuration = videoDurations[videoName] || 300;
    const currentFrame = Math.floor((Date.now() - videoStartTime) / 1000 * FPS) % (videoDuration * FPS);
    const currentTime = currentFrame / FPS;

    let pixels;
    if (req.query.realtime === 'true') {
      pixels = await processSingleFrame(currentTime, videoName);
      if (!pixels) {
        return res.status(500).json({ 
          error: 'Failed to process frame', 
          synchronized: false 
        });
      }
    } else {
      pixels = lastPixels;
    }

    res.json({
      pixels: pixels || [],
      frame: currentFrame,
      timestamp: currentTime,
      width: WIDTH,
      height: HEIGHT,
      serverTime: Date.now(),
      videoStartTime,
      synchronized: true,
      processing: isProcessing,
      errors: consecutiveErrors,
      activeInstances: activeInstances.size
    });
  } catch (error) {
    log('error', 'Frame endpoint error:', error.message);
    res.status(500).json({
      error: 'Internal server error',
      pixels: lastPixels,
      synchronized: false
    });
  }
});

app.get('/sync', (req, res) => {
  try {
    const videoName = req.query.video || DEFAULT_VIDEO;
    
    if (!VIDEO_FILES[videoName]) {
      return res.status(400).json({ 
        error: `Invalid video name: ${videoName}`,
        availableVideos: Object.keys(VIDEO_FILES)
      });
    }
    
    const videoDuration = videoDurations[videoName] || 300;
    const currentFrame = Math.floor((Date.now() - videoStartTime) / 1000 * FPS) % (videoDuration * FPS);
    const currentTime = currentFrame / FPS;

    res.json({
      currentTime,
      currentFrame,
      serverTime: Date.now(),
      videoStartTime,
      videoDuration,
      fps: FPS,
      synchronized: true,
      resolution: `${WIDTH}x${HEIGHT}`,
      performance: performanceStats,
      activeInstances: activeInstances.size
    });
  } catch (error) {
    log('error', 'Sync endpoint error:', error.message);
    res.status(500).json({
      error: 'Internal server error',
      synchronized: false
    });
  }
});

app.get('/health', (req, res) => {
  try {
    const isHealthy = Object.keys(videoDurations).length > 0 &&
                      consecutiveErrors < MAX_CONSECUTIVE_ERRORS &&
                      performanceStats.lastSuccessTime > 0 &&
                      (Date.now() - performanceStats.lastSuccessTime) < 60000;

    const memUsage = process.memoryUsage();

    res.status(isHealthy ? 200 : 503).json({
      status: isHealthy ? 'healthy' : 'unhealthy',
      uptime: process.uptime(),
      timestamp: new Date().toISOString(),
      checks: {
        videosExist: Object.fromEntries(
          Object.entries(VIDEO_FILES).map(([name, path]) => [
            name,
            videoDurations[name] !== 300
          ])
        ),
        errorsUnderControl: consecutiveErrors < MAX_CONSECUTIVE_ERRORS,
        videoDurationsKnown: Object.keys(videoDurations).length > 0,
        recentSuccess: (Date.now() - performanceStats.lastSuccessTime) < 60000,
        memoryHealthy: memUsage.heapUsed < MEMORY_THRESHOLD,
        activeFFmpegInstances: activeInstances.size
      },
      stats: {
        totalFramesProcessed,
        totalErrors,
        consecutiveErrors,
        successRate: performanceStats.successRate,
        avgProcessingTime: performanceStats.avgProcessingTime,
        activeInstances: activeInstances.size,
        memoryUsage: {
          heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
          heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
          external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
        }
      }
    });
  } catch (error) {
    log('error', 'Health endpoint error:', error.message);
    res.status(500).json({
      status: 'error',
      error: error.message
    });
  }
});

app.get('/debug', (req, res) => {
  const instanceDetails = Array.from(activeInstances.entries()).map(([id, info]) => ({
    id,
    status: info.status,
    startTime: info.startTime,
    age: Date.now() - info.startTime,
    processId: info.processId,
    targetTime: info.targetTime
  }));

  res.json({
    videoDurations,
    lastPixelsLength: lastPixels.length,
    isProcessing,
    consecutiveErrors,
    activeInstancesCount: activeInstances.size,
    instanceDetails,
    performanceStats,
    memoryUsage: process.memoryUsage(),
    instanceCounter,
    concurrencyStats: {
      activeFFmpegCount,
      maxConcurrentFFmpeg: MAX_CONCURRENT_FFMPEG
    }
  });
});

// Global error handlers
process.on('unhandledRejection', (reason, promise) => {
  log('error', 'Unhandled Promise Rejection:', reason);
});

process.on('uncaughtException', (error) => {
  log('error', 'Uncaught Exception:', error);
  process.exit(1);
});

// Signal handlers
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGUSR1', () => gracefulShutdown('SIGUSR1'));
process.on('SIGUSR2', () => gracefulShutdown('SIGUSR2'));

app.use((err, req, res, next) => {
  log('error', 'Unhandled error:', err);
  res.status(500).json({ error: 'Internal server error' });
});

app.listen(PORT, () => {
  log('info', `Video Server running on Koyeb`);
  log('info', `Fixed Resolution: ${WIDTH}x${HEIGHT} @ ${FPS}fps`);
  log('info', `Max Concurrent FFmpeg: ${MAX_CONCURRENT_FFMPEG}`);
  log('info', `Memory Threshold: ${Math.round(MEMORY_THRESHOLD / 1024 / 1024)}MB`);
  log('info', `Log Level: ${LOG_LEVEL}`);
  log('info', `Available videos: ${Object.keys(VIDEO_FILES).join(', ')}`);
});
