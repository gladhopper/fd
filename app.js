const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');
const path = require('path');

// Use system-installed FFmpeg (from Dockerfile)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8000;

// Point to video file (bundled with Docker image)
const VIDEO_PATH = '/app/s.mp4';

// ENHANCED DEBUGGING BLOCK
console.log('=== ENHANCED FILE SYSTEM CHECK ===');
console.log('Current working directory:', process.cwd());
console.log('VIDEO_PATH:', VIDEO_PATH);

try {
  console.log('All files in /app:', fs.readdirSync('/app'));
  console.log('Does VIDEO_PATH exist?', fs.existsSync(VIDEO_PATH));
  
  if (fs.existsSync(VIDEO_PATH)) {
    const stats = fs.statSync(VIDEO_PATH);
    console.log('File size:', stats.size, 'bytes');
    console.log('File permissions:', stats.mode.toString(8));
    console.log('Is readable:', fs.constants.R_OK & stats.mode);
    
    try {
      const testBuffer = fs.readFileSync(VIDEO_PATH, { flag: 'r', highWaterMark: 1024 });
      console.log('File header (first 32 bytes):', testBuffer.slice(0, 32).toString('hex'));
      console.log('✅ File is accessible and readable');
    } catch (readErr) {
      console.error('❌ File read test failed:', readErr.message);
    }
  }
  
  const alternatives = ['/app/s.mp4', './s.mp4', 's.mp4'];
  alternatives.forEach(alt => {
    if (fs.existsSync(alt)) {
      console.log(`Found alternative at: ${alt}`);
    }
  });
  
} catch (error) {
  console.error('❌ Critical file system error:', error);
}
console.log('=== END ENHANCED DEBUG ===');

// FIXED QUALITY SETTINGS - All output 160x120 for Roblox compatibility
const QUALITY_PROFILES = {
  low: { width: 160, height: 120, fps: 8, preset: 'ultrafast' },
  medium: { width: 160, height: 120, fps: 10, preset: 'veryfast' },
  high: { width: 160, height: 120, fps: 12, preset: 'fast' },
  ultra: { width: 160, height: 120, fps: 15, preset: 'medium' }
};

// Start with medium quality to reduce initial resource load
let currentProfile = 'medium';
let { width: WIDTH, height: HEIGHT, fps: FPS, preset: PRESET } = QUALITY_PROFILES[currentProfile];
let FRAME_INTERVAL = 1000 / FPS;

const MAX_CONSECUTIVE_ERRORS = 5;
const QUALITY_ADJUSTMENT_THRESHOLD = 5; // Lowered to trigger downgrades sooner

// ENHANCED SYNCHRONIZATION
const VIDEO_START_OFFSET = parseFloat(process.env.VIDEO_START_OFFSET || 0);
let videoStartTime = Date.now() - (VIDEO_START_OFFSET * 1000);
let videoDuration = 0;
let lastPixels = [];
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let totalErrors = 0;
let lastProcessingTimes = [];
let qualityAdjustmentTimer = 0;

// PERFORMANCE MONITORING
const performanceStats = {
  avgProcessingTime: 0,
  successRate: 0,
  lastSuccessTime: 0,
  memoryUsage: null,
  cpuUsage: null
};

// Handle SIGTERM for graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, cleaning up...');
  if (ffmpegInstance) {
    ffmpegInstance.kill('SIGTERM');
  }
  process.exit(0);
});

// CORS with enhanced headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// ROBUST video duration detection with fallbacks
const getVideoDuration = () => {
  return new Promise((resolve) => {
    console.log('🔍 Analyzing video file:', VIDEO_PATH);
    
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file not found, using fallback duration');
      resolve(300); // 5 minute fallback
      return;
    }
    
    const timeoutId = setTimeout(() => {
      console.warn('⚠️ ffprobe timeout, using fallback');
      resolve(300);
    }, 10000);
    
    ffmpeg.ffprobe(VIDEO_PATH, (err, metadata) => {
      clearTimeout(timeoutId);
      
      if (err) {
        console.warn('⚠️ ffprobe failed:', err.message);
        console.warn('Using fallback duration');
        resolve(300);
      } else {
        const duration = metadata.format.duration || 300;
        console.log('✅ Video analysis complete:');
        console.log(`   Duration: ${duration}s (${Math.floor(duration/60)}:${Math.floor(duration%60).toString().padStart(2,'0')})`);
        console.log(`   Codec: ${metadata.streams[0]?.codec_name || 'unknown'}`);
        console.log(`   Resolution: ${metadata.streams[0]?.width || 'unknown'}x${metadata.streams[0]?.height || 'unknown'}`);
        resolve(duration);
      }
    });
  });
};

// ADAPTIVE QUALITY MANAGEMENT
const adjustQuality = (direction) => {
  const profiles = Object.keys(QUALITY_PROFILES);
  const currentIndex = profiles.indexOf(currentProfile);
  
  if (direction === 'down' && currentIndex > 0) {
    currentProfile = profiles[currentIndex - 1];
    console.log(`📉 Quality downgraded to: ${currentProfile}`);
  } else if (direction === 'up' && currentIndex < profiles.length - 1) {
    currentProfile = profiles[currentIndex + 1];
    console.log(`📈 Quality upgraded to: ${currentProfile}`);
  }
  
  const profile = QUALITY_PROFILES[currentProfile];
  WIDTH = profile.width;
  HEIGHT = profile.height;
  FPS = profile.fps;
  PRESET = profile.preset;
  FRAME_INTERVAL = 1000 / FPS; // Update FRAME_INTERVAL
  
  console.log(`🎥 New settings: ${WIDTH}x${HEIGHT} @ ${FPS}fps (${PRESET})`);
};

// ENHANCED frame processing with better error handling and optimization
let ffmpegInstance = null; // Track FFmpeg instance for cleanup
const processSingleFrame = async (targetTime) => {
  return new Promise((resolve) => {
    console.log(`🎬 Processing frame at ${targetTime.toFixed(2)}s (${currentProfile})`);
    
    const startTime = Date.now();
    let pixelBuffer = Buffer.alloc(0);
    let outputStream = null;
    let streamEnded = false;
    
    // Dynamic timeout based on quality profile
    const timeout = currentProfile === 'ultra' ? 3000 : 
                   currentProfile === 'high' ? 2000 : 1500;
    
    const streamTimeout = setTimeout(() => {
      if (!streamEnded) {
        console.log(`⏰ Frame timeout at ${targetTime.toFixed(2)}s (${timeout}ms)`);
        cleanup();
        resolve(null);
      }
    }, timeout);
    
    const cleanup = () => {
      if (streamEnded) return;
      streamEnded = true;
      clearTimeout(streamTimeout);
      
      if (outputStream && !outputStream.destroyed) {
        outputStream.destroy();
      }
      
      if (ffmpegInstance) {
        try {
          ffmpegInstance.kill('SIGTERM');
        } catch (e) {
          console.error('Error killing FFmpeg:', e.message);
        }
        ffmpegInstance = null;
      }
    };
    
    try {
      if (!fs.existsSync(VIDEO_PATH)) {
        console.error('❌ Video file missing during processing');
        cleanup();
        resolve(null);
        return;
      }
      
      outputStream = new PassThrough();
      
      outputStream.on('data', chunk => {
        if (!streamEnded) {
          pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
        }
      });
      
      outputStream.on('end', () => {
        if (streamEnded) return;
        cleanup();
        
        const processingTime = Date.now() - startTime;
        
        try {
          const expectedSize = WIDTH * HEIGHT * 3;
          if (pixelBuffer.length !== expectedSize) {
            console.warn(`⚠️ Buffer size mismatch: got ${pixelBuffer.length}, expected ${expectedSize}`);
          }
          
          const pixels = [];
          for (let i = 0; i < Math.min(pixelBuffer.length, expectedSize); i += 3) {
            if (i + 2 < pixelBuffer.length) {
              pixels.push([
                pixelBuffer[i] || 0,
                pixelBuffer[i + 1] || 0,
                pixelBuffer[i + 2] || 0
              ]);
            }
          }
          
          console.log(`✅ Frame at ${targetTime.toFixed(2)}s: ${pixels.length} pixels (${processingTime}ms)`);
          
          lastProcessingTimes.push(processingTime);
          if (lastProcessingTimes.length > 10) {
            lastProcessingTimes.shift();
          }
          
          resolve(pixels);
          
        } catch (pixelError) {
          console.error('❌ Pixel processing error:', pixelError.message);
          resolve(null);
        }
      });
      
      outputStream.on('error', (err) => {
        cleanup();
        console.error(`❌ Stream error at ${targetTime.toFixed(2)}s:`, err.message);
        resolve(null);
      });
      
      ffmpegInstance = ffmpeg(VIDEO_PATH)
        .seekInput(Math.max(0, targetTime))
        .frames(1)
        .size(`${WIDTH}x${HEIGHT}`)
        .outputOptions([
          '-pix_fmt rgb24',
          `-preset ${PRESET}`,
          '-tune fastdecode',
          '-threads 1',
          '-avoid_negative_ts make_zero',
          '-fflags +genpts+discardcorrupt',
          '-f rawvideo'
        ])
        .format('rawvideo')
        .on('start', (cmd) => {
          console.log('FFmpeg command:', cmd); // Log for debugging
        })
        .on('error', (err, stdout, stderr) => {
          cleanup();
          console.error(`❌ FFmpeg error at ${targetTime.toFixed(2)}s:`, err.message);
          console.error('FFmpeg stderr:', stderr);
          resolve(null);
        })
        .on('stderr', (stderrLine) => {
          if (stderrLine.includes('error') || stderrLine.includes('failed')) {
            console.warn('FFmpeg stderr:', stderrLine);
          }
        });
      
      ffmpegInstance.pipe(outputStream, { end: true });
      
    } catch (err) {
      cleanup();
      console.error('❌ Failed to create FFmpeg process:', err.message);
      resolve(null);
    }
  });
};

// Initialize duration and start processing
(async () => {
  try {
    videoDuration = await getVideoDuration();
    console.log(`🎥 Video ready: ${videoDuration}s duration`);
    console.log(`📊 Total frames available: ${Math.floor(videoDuration * FPS)}`);
    console.log(`🎯 Starting quality: ${currentProfile} (${WIDTH}x${HEIGHT} @ ${FPS}fps)`);
    
    if (VIDEO_START_OFFSET > 0) {
      console.log(`⏩ Video offset: ${VIDEO_START_OFFSET}s`);
    }
    
    startProcessingLoop();
    
  } catch (err) {
    console.error('❌ Initialization failed:', err);
    videoDuration = 300;
    startProcessingLoop();
  }
})();

// Calculate synchronized video time
const getCurrentVideoTime = () => {
  if (!videoDuration) return 0;
  const elapsed = (Date.now() - videoStartTime) / 1000;
  return Math.max(0, elapsed % videoDuration);
};

const getCurrentFrameNumber = () => {
  return Math.floor(getCurrentVideoTime() * FPS);
};

// INTELLIGENT processing loop with adaptive quality
let isProcessing = false;
let lastSuccessfulTime = -1;

const processFrameLoop = async () => {
  if (!videoDuration || isProcessing) return;
  
  // Monitor resources
  performanceStats.memoryUsage = process.memoryUsage();
  performanceStats.cpuUsage = process.cpuUsage();
  
  // Force downgrade on excessive errors
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    adjustQuality('down');
    consecutiveErrors = 0;
    const pauseTime = Math.min(consecutiveErrors * 1000, 8000);
    console.log(`⏸️ Pausing for ${pauseTime/1000}s due to errors`);
    await new Promise(resolve => setTimeout(resolve, pauseTime));
    return;
  }
  
  // Downgrade on high resource usage
  if (performanceStats.memoryUsage && performanceStats.memoryUsage.heapUsed > 200 * 1024 * 1024) { // 200MB threshold
    adjustQuality('down');
    console.log('📉 Downgraded due to high memory usage');
  }
  
  isProcessing = true;
  const currentTime = getCurrentVideoTime();
  
  if (Math.abs(currentTime - lastSuccessfulTime) < (1 / FPS)) {
    isProcessing = false;
    return;
  }
  
  const pixels = await processSingleFrame(currentTime);
  
  if (pixels && pixels.length > 0) {
    lastPixels = pixels;
    lastSuccessfulTime = currentTime;
    consecutiveErrors = 0;
    totalFramesProcessed++;
    performanceStats.lastSuccessTime = Date.now();
    
    performanceStats.successRate = totalFramesProcessed / (totalFramesProcessed + totalErrors);
    
    if (lastProcessingTimes.length > 0) {
      performanceStats.avgProcessingTime = lastProcessingTimes.reduce((a, b) => a + b, 0) / lastProcessingTimes.length;
    }
    
    qualityAdjustmentTimer++;
    if (qualityAdjustmentTimer > 50 && performanceStats.avgProcessingTime < 300 && consecutiveErrors === 0) {
      adjustQuality('up');
      qualityAdjustmentTimer = 0;
    }
    
  } else {
    consecutiveErrors++;
    totalErrors++;
    console.log(`❌ Failed frame (${consecutiveErrors} consecutive errors)`);
  }
  
  isProcessing = false;
};

const startProcessingLoop = () => {
  setInterval(processFrameLoop, FRAME_INTERVAL);
  console.log(`🚀 Enhanced video processing started at ${FPS} FPS`);
};

// ENHANCED API endpoints
app.get('/frame', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    pixels: lastPixels,
    frame: currentFrame,
    timestamp: currentTime,
    width: WIDTH,
    height: HEIGHT,
    serverTime: Date.now(),
    videoStartTime: videoStartTime,
    synchronized: true,
    quality: currentProfile,
    stats: {
      totalFrames: totalFramesProcessed,
      totalErrors: totalErrors,
      consecutiveErrors: consecutiveErrors,
      successRate: Math.round(performanceStats.successRate * 100) / 100,
      avgProcessingTime: Math.round(performanceStats.avgProcessingTime)
    }
  });
});

app.get('/sync', (req, res) => {
  res.json({
    currentTime: getCurrentVideoTime(),
    currentFrame: getCurrentFrameNumber(),
    serverTime: Date.now(),
    videoStartTime: videoStartTime,
    videoDuration: videoDuration,
    fps: FPS,
    synchronized: true,
    quality: currentProfile,
    resolution: `${WIDTH}x${HEIGHT}`
  });
});

app.get('/info', (req, res) => {
  res.json({
    status: 'Enhanced Adaptive Video Server - ROBLOX OPTIMIZED',
    currentFrame: getCurrentFrameNumber(),
    timestamp: getCurrentVideoTime(),
    duration: videoDuration,
    fps: FPS,
    quality: currentProfile,
    resolution: `${WIDTH}x${HEIGHT}`,
    totalFrames: Math.floor(videoDuration * FPS),
    isProcessing,
    consecutiveErrors,
    performance: performanceStats,
    availableQualities: Object.keys(QUALITY_PROFILES)
  });
});

app.get('/quality/:profile', (req, res) => {
  const profile = req.params.profile;
  if (QUALITY_PROFILES[profile]) {
    currentProfile = profile;
    const settings = QUALITY_PROFILES[profile];
    WIDTH = settings.width;
    HEIGHT = settings.height;
    FPS = settings.fps;
    PRESET = settings.preset;
    FRAME_INTERVAL = 1000 / FPS;
    
    console.log(`🎛️ Quality manually set to: ${currentProfile}`);
    res.json({ success: true, quality: currentProfile, settings });
  } else {
    res.status(400).json({ error: 'Invalid quality profile', available: Object.keys(QUALITY_PROFILES) });
  }
});

app.get('/debug', (req, res) => {
  res.json({
    videoPath: VIDEO_PATH,
    fileExists: fs.existsSync(VIDEO_PATH),
    fileSize: fs.existsSync(VIDEO_PATH) ? fs.statSync(VIDEO_PATH).size : null,
    currentFrame: getCurrentFrameNumber(),
    currentTime: getCurrentVideoTime(),
    videoDuration,
    quality: currentProfile,
    resolution: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    preset: PRESET,
    performance: performanceStats,
    lastProcessingTimes,
    consecutiveErrors,
    totalErrors,
    isProcessing,
    pixelsCount: lastPixels.length
  });
});

app.get('/', (req, res) => {
  res.json({
    status: `Enhanced Adaptive Video Server - ROBLOX OPTIMIZED - ${currentProfile.toUpperCase()}`,
    frame: getCurrentFrameNumber(),
    timestamp: getCurrentVideoTime(),
    duration: videoDuration,
    quality: currentProfile,
    resolution: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    pixelsCount: lastPixels.length,
    performance: performanceStats,
    synchronized: true,
    enhanced: true,
    robloxOptimized: true
  });
});

// Health check endpoint with resource monitoring
app.get('/health', (req, res) => {
  const isHealthy = fs.existsSync(VIDEO_PATH) && 
                   consecutiveErrors < MAX_CONSECUTIVE_ERRORS &&
                   videoDuration > 0;
  
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    checks: {
      fileExists: fs.existsSync(VIDEO_PATH),
      errorsUnderControl: consecutiveErrors < MAX_CONSECUTIVE_ERRORS,
      videoDurationKnown: videoDuration > 0,
      recentSuccess: (Date.now() - performanceStats.lastSuccessTime) < 30000,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    }
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌟 Enhanced Video Server (ROBLOX OPTIMIZED) running at http://0.0.0.0:${PORT}`);
  console.log(`🎥 Fixed Resolution: ${WIDTH}x${HEIGHT} @ ${FPS}fps (${currentProfile})`);
  console.log(`📊 Health check: http://0.0.0.0:${PORT}/health`);
  console.log(`🎛️ Quality control: http://0.0.0.0:${PORT}/quality/{low|medium|high|ultra}`);
  console.log(`🔍 Debug info: http://0.0.0.0:${PORT}/debug`);
  console.log(`🎮 Roblox Client URLs:`);
  console.log(`   Frame: http://plastic-ardeen-fdsz-3c9c531a.koyeb.app:${PORT}/frame`);
  console.log(`   Sync:  http://plastic-ardeen-fdsz-3c9c531a.koyeb.app:${PORT}/sync`);
});
