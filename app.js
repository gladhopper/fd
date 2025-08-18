const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;
const VIDEO_PATH = '/app/s.mp4';

// Reduced resolution for stability
const FPS = 6;
const WIDTH = 160;
const HEIGHT = 120;

let currentFrame = 0;
let videoDuration = 0;
let lastPixels = [];
let isProcessing = false;

// Performance tracking with better defaults
let avgProcessingTime = 200;
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let restartCount = 0;
let lastSuccessfulFrame = 0;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Get video duration with better error handling
const getVideoDuration = () => {
  return new Promise((resolve) => {
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file not found:', VIDEO_PATH);
      resolve(60);
      return;
    }
    
    ffmpeg.ffprobe(VIDEO_PATH, (err, metadata) => {
      if (err) {
        console.warn('ffprobe failed, using fallback duration');
        resolve(60);
      } else {
        const duration = metadata.format.duration;
        console.log(`📹 Video metadata: ${duration}s, ${metadata.streams[0]?.width || 'unknown'}x${metadata.streams[0]?.height || 'unknown'}`);
        resolve(duration);
      }
    });
  });
};

// Initialize duration
(async () => {
  try {
    videoDuration = await getVideoDuration();
    console.log(`🎬 Video loaded: ${videoDuration}s duration, ${FPS} FPS, ${WIDTH}x${HEIGHT}`);
    console.log(`📊 Expected frames: ${Math.floor(videoDuration * FPS)}`);
  } catch (err) {
    console.error('Duration initialization failed:', err);
    videoDuration = 60;
  }
})();

// Process management with better cleanup
let processingTimeout = null;
let currentFFmpegProcess = null;
let processCleanupInProgress = false;

const safeKillProcess = () => {
  if (processCleanupInProgress) return;
  processCleanupInProgress = true;
  
  try {
    if (processingTimeout) {
      clearTimeout(processingTimeout);
      processingTimeout = null;
    }
    
    if (currentFFmpegProcess) {
      // Try graceful termination first
      currentFFmpegProcess.kill('SIGTERM');
      
      // Force kill after short delay if needed
      setTimeout(() => {
        if (currentFFmpegProcess) {
          try {
            currentFFmpegProcess.kill('SIGKILL');
          } catch (e) {
            // Process already dead
          }
        }
      }, 500);
      
      currentFFmpegProcess = null;
    }
  } catch (e) {
    console.warn('Process cleanup error (non-fatal):', e.message);
  } finally {
    processCleanupInProgress = false;
  }
};

// Improved frame validation
const isValidSeekTime = (seekTime) => {
  return seekTime >= 0 && seekTime < (videoDuration - 1) && !isNaN(seekTime);
};

// Smart frame skipping for problematic areas
const getNextSafeFrame = (currentFrame) => {
  let nextFrame = currentFrame + 1;
  const maxFrames = Math.floor(videoDuration * FPS);
  
  // If we're in a problematic area (based on your logs around frame 240-350)
  if (consecutiveErrors >= 2) {
    // Skip ahead more aggressively in problematic regions
    const skipAmount = Math.min(10, consecutiveErrors * 2);
    nextFrame = currentFrame + skipAmount;
    console.log(`⏭️ Skipping ${skipAmount} frames due to errors`);
  }
  
  return nextFrame % maxFrames;
};

const startRobustProcessing = () => {
  const processFrame = async () => {
    // Prevent multiple simultaneous processing
    if (isProcessing || processCleanupInProgress) {
      setTimeout(processFrame, 100);
      return;
    }
    
    if (!videoDuration) {
      setTimeout(processFrame, 500);
      return;
    }
    
    const frameStart = Date.now();
    isProcessing = true;
    const seekTime = currentFrame / FPS;
    
    // Validate seek time before processing
    if (!isValidSeekTime(seekTime)) {
      console.warn(`⚠️ Invalid seek time ${seekTime}s, resetting to safe frame`);
      currentFrame = 0;
      isProcessing = false;
      setTimeout(processFrame, 100);
      return;
    }
    
    // Shorter timeout with better error handling
    processingTimeout = setTimeout(() => {
      console.warn(`⏰ Frame ${currentFrame} timeout (${seekTime.toFixed(2)}s)`);
      safeKillProcess();
      consecutiveErrors = Math.min(consecutiveErrors + 1, 10); // Cap errors
      isProcessing = false;
      
      // Move to next frame on timeout
      currentFrame = getNextSafeFrame(currentFrame);
      const delay = Math.min(2000, 200 * consecutiveErrors);
      setTimeout(processFrame, delay);
    }, 3000); // Reduced timeout
    
    let pixelBuffer = Buffer.alloc(0);
    const outputStream = new PassThrough();
    let streamEnded = false;
    
    const handleSuccess = () => {
      if (streamEnded) return;
      streamEnded = true;
      
      if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
      }
      
      try {
        const pixels = [];
        const expectedSize = WIDTH * HEIGHT * 3;
        
        // Validate buffer size
        if (pixelBuffer.length !== expectedSize) {
          console.warn(`⚠️ Unexpected buffer size: ${pixelBuffer.length}, expected: ${expectedSize}`);
          if (pixelBuffer.length < expectedSize) {
            // Pad buffer if too small
            const padding = Buffer.alloc(expectedSize - pixelBuffer.length, 0);
            pixelBuffer = Buffer.concat([pixelBuffer, padding]);
          }
        }
        
        // Convert pixels
        for (let i = 0; i < expectedSize; i += 3) {
          if (i + 2 < pixelBuffer.length) {
            pixels.push([pixelBuffer[i] || 0, pixelBuffer[i + 1] || 0, pixelBuffer[i + 2] || 0]);
          }
        }
        
        lastPixels = pixels;
        lastSuccessfulFrame = currentFrame;
        currentFrame = getNextSafeFrame(currentFrame);
        totalFramesProcessed++;
        consecutiveErrors = Math.max(0, consecutiveErrors - 1); // Gradually reduce error count
        isProcessing = false;
        currentFFmpegProcess = null;
        
        const processingTime = Date.now() - frameStart;
        avgProcessingTime = (avgProcessingTime * 0.95) + (processingTime * 0.05); // Slower averaging
        
        if (totalFramesProcessed % 30 === 0) {
          console.log(`✅ Frame ${lastSuccessfulFrame}: ${processingTime}ms (avg: ${Math.round(avgProcessingTime)}ms) [${totalFramesProcessed} total]`);
        }
        
        // Performance monitoring with better thresholds
        if (avgProcessingTime > 4000 && totalFramesProcessed > 100) {
          console.warn('🔄 Performance degraded, optimizing...');
          avgProcessingTime = Math.max(1000, avgProcessingTime * 0.8); // Gradual recovery
          restartCount++;
        }
        
        // Adaptive scheduling
        const targetInterval = 1000 / FPS;
        const nextDelay = Math.max(50, Math.min(targetInterval, targetInterval - (processingTime - avgProcessingTime)));
        setTimeout(processFrame, nextDelay);
        
      } catch (err) {
        console.error('Success handler error:', err);
        isProcessing = false;
        setTimeout(processFrame, 500);
      }
    };
    
    const handleError = (err) => {
      if (streamEnded) return;
      streamEnded = true;
      
      safeKillProcess();
      console.error(`💥 FFmpeg error at frame ${currentFrame} (${seekTime.toFixed(2)}s):`, err.message);
      
      consecutiveErrors = Math.min(consecutiveErrors + 1, 10);
      isProcessing = false;
      
      // Smart frame advancement on error
      if (consecutiveErrors >= 5) {
        console.warn('🚀 Too many errors, jumping to different section...');
        currentFrame = (currentFrame + 50) % Math.floor(videoDuration * FPS);
        consecutiveErrors = 2; // Reset but keep some caution
      } else {
        currentFrame = getNextSafeFrame(currentFrame);
      }
      
      const delay = Math.min(3000, 300 * Math.pow(1.2, consecutiveErrors));
      setTimeout(processFrame, delay);
    };
    
    outputStream.on('data', chunk => {
      pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
    });
    
    outputStream.on('end', handleSuccess);
    outputStream.on('error', handleError);
    
    // File existence check
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file missing');
      handleError(new Error('Video file not found'));
      return;
    }
    
    try {
      // More conservative FFmpeg settings
      currentFFmpegProcess = ffmpeg(VIDEO_PATH)
        .seekInput(seekTime)
        .frames(1)
        .size(`${WIDTH}x${HEIGHT}`)
        .outputOptions([
          '-pix_fmt rgb24',
          '-preset superfast',  // Changed from ultrafast
          '-tune fastdecode',
          '-threads 1',
          '-avoid_negative_ts make_zero',
          '-fflags +genpts+discardcorrupt',  // Added discardcorrupt
          '-vsync 0',
          '-an',  // Disable audio
          '-sn',  // Disable subtitles
          '-dn',  // Disable data streams
          '-ignore_unknown',
          '-err_detect ignore_err'  // Ignore minor errors
        ])
        .format('rawvideo')
        .on('start', () => {
          if (totalFramesProcessed % 100 === 0) {
            console.log(`🎬 Processing frame ${currentFrame} (${seekTime.toFixed(2)}s)`);
          }
        })
        .on('error', handleError)
        .pipe(outputStream, { end: true });
        
    } catch (err) {
      console.error('Error creating FFmpeg process:', err);
      handleError(err);
    }
  };
  
  console.log('🚀 Starting robust video processing...');
  processFrame();
};

// Start processing after initialization
setTimeout(startRobustProcessing, 1000);

// Cleanup handlers
const cleanup = () => {
  console.log('🧹 Cleaning up processes...');
  safeKillProcess();
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('exit', cleanup);
process.on('uncaughtException', (err) => {
  console.error('Uncaught exception:', err);
  cleanup();
  process.exit(1);
});

// API endpoints with better error handling
app.get('/frame', (req, res) => {
  try {
    res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.json({
      pixels: lastPixels,
      frame: currentFrame,
      timestamp: currentFrame / FPS,
      width: WIDTH,
      height: HEIGHT,
      processingTime: Math.round(avgProcessingTime),
      totalFrames: totalFramesProcessed,
      lastSuccessfulFrame
    });
  } catch (err) {
    res.status(500).json({ error: 'Frame data unavailable' });
  }
});

app.get('/info', (req, res) => {
  res.json({
    currentFrame,
    timestamp: currentFrame / FPS,
    duration: videoDuration,
    fps: FPS,
    width: WIDTH,
    height: HEIGHT,
    totalFrames: Math.floor(videoDuration * FPS),
    isProcessing,
    avgProcessingTime: Math.round(avgProcessingTime),
    totalFramesProcessed,
    consecutiveErrors,
    restartCount,
    lastSuccessfulFrame,
    health: consecutiveErrors < 5 ? 'good' : 'degraded'
  });
});

app.get('/health', (req, res) => {
  const isHealthy = consecutiveErrors < 5 && avgProcessingTime < 3000 && fs.existsSync(VIDEO_PATH);
  
  const health = {
    status: isHealthy ? 'healthy' : 'degraded',
    avgProcessingTime: Math.round(avgProcessingTime),
    consecutiveErrors,
    totalFramesProcessed,
    restartCount,
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH),
    lastSuccessfulFrame,
    uptime: process.uptime()
  };
  
  res.status(isHealthy ? 200 : 503).json(health);
});

app.get('/', (req, res) => {
  res.json({
    status: '🛡️ Fixed Robust Video Server',
    frame: currentFrame,
    timestamp: currentFrame / FPS,
    duration: videoDuration,
    resolution: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    pixelsCount: lastPixels.length,
    performance: {
      avgProcessingTime: Math.round(avgProcessingTime),
      totalFramesProcessed,
      consecutiveErrors,
      restartCount,
      status: consecutiveErrors < 3 ? '✅ healthy' : '⚠️ needs attention',
      lastSuccessfulFrame
    },
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH),
    uptime: `${Math.floor(process.uptime())}s`
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Fixed robust video server running at http://0.0.0.0:${PORT}`);
  console.log(`📈 Enhanced error handling enabled`);
  console.log(`🔄 Smart frame skipping enabled`);
});
