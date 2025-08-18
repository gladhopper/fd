const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;
const VIDEO_PATH = '/app/s.mp4';

// Higher resolution settings
const FPS = 6;
const WIDTH = 192;
const HEIGHT = 144;

let currentFrame = 0;
let videoDuration = 0;
let lastPixels = [];
let isProcessing = false;

// Performance tracking
let avgProcessingTime = 200;
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let restartCount = 0;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Get video duration
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
        resolve(metadata.format.duration);
      }
    });
  });
};

// Initialize duration
(async () => {
  try {
    videoDuration = await getVideoDuration();
    console.log(`🎬 Video loaded: ${videoDuration}s duration, ${FPS} FPS, ${WIDTH}x${HEIGHT} (HIGH-RES)`);
    console.log(`📊 Expected frames: ${Math.floor(videoDuration * FPS)}, Pixels per frame: ${WIDTH * HEIGHT}`);
  } catch (err) {
    console.error('Duration initialization failed:', err);
    videoDuration = 60;
  }
})();

// ROBUST frame processing with automatic cleanup
let processingTimeout = null;
let currentFFmpegProcess = null;

const killCurrentProcess = () => {
  if (currentFFmpegProcess) {
    try {
      currentFFmpegProcess.kill('SIGKILL');
      console.log('🔥 Killed stuck FFmpeg process');
    } catch (e) {
      // Process may already be dead
    }
    currentFFmpegProcess = null;
  }
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
};

const startRobustProcessing = () => {
  const processFrame = () => {
    // Prevent multiple simultaneous processing
    if (isProcessing) {
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
    
    // TIMEOUT PROTECTION - kill process if it takes too long
    processingTimeout = setTimeout(() => {
      console.warn('⚠️ Frame processing timeout, killing FFmpeg process');
      killCurrentProcess();
      consecutiveErrors++;
      isProcessing = false;
      
      // Exponential backoff on timeouts
      const delay = Math.min(3000, 500 * Math.pow(1.2, consecutiveErrors));
      setTimeout(processFrame, delay);
    }, 5000); // Reduced to 5 second timeout
    
    let pixelBuffer = Buffer.alloc(0);
    const outputStream = new PassThrough();
    
    outputStream.on('data', chunk => {
      pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
    });
    
    outputStream.on('end', () => {
      // Clear timeout - we succeeded
      if (processingTimeout) {
        clearTimeout(processingTimeout);
        processingTimeout = null;
      }
      
      const pixels = [];
      for (let i = 0; i < pixelBuffer.length; i += 3) {
        pixels.push([pixelBuffer[i], pixelBuffer[i + 1], pixelBuffer[i + 2]]);
      }
      
      lastPixels = pixels;
      currentFrame = (currentFrame + 1) % Math.floor(videoDuration * FPS);
      totalFramesProcessed++;
      consecutiveErrors = 0; // Reset error count on success
      isProcessing = false;
      currentFFmpegProcess = null;
      
      const processingTime = Date.now() - frameStart;
      avgProcessingTime = (avgProcessingTime * 0.9) + (processingTime * 0.1);
      
      // Less frequent logging to reduce I/O overhead
      if (totalFramesProcessed % 30 == 0) {
        console.log(`✅ Frame ${currentFrame}: ${processingTime}ms (avg: ${Math.round(avgProcessingTime)}ms) [${totalFramesProcessed} total]`);
      }
      
      // PERFORMANCE MONITORING - restart if performance degrades severely
      if (avgProcessingTime > 5000 && totalFramesProcessed > 50) {
        console.warn('🔄 Performance degraded severely, restarting processing...');
        restartCount++;
        avgProcessingTime = 1000; // Reset average
        consecutiveErrors = 0;
        
        // Restart with longer delay
        setTimeout(processFrame, 2000);
        return;
      }
      
      // Adaptive scheduling based on performance
      const targetDelay = 1000 / FPS;
      const nextDelay = Math.max(50, targetDelay - processingTime);
      setTimeout(processFrame, nextDelay);
    });
    
    outputStream.on('error', (err) => {
      console.error('Output stream error:', err);
      killCurrentProcess();
      consecutiveErrors++;
      isProcessing = false;
      
      const delay = Math.min(3000, 500 * consecutiveErrors);
      setTimeout(processFrame, delay);
    });
    
    // File existence check
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file missing at processing time');
      killCurrentProcess();
      isProcessing = false;
      setTimeout(processFrame, 2000);
      return;
    }
    
    try {
      // CREATE FFMPEG PROCESS
      currentFFmpegProcess = ffmpeg(VIDEO_PATH)
        .seekInput(seekTime)
        .frames(1)
        .size(`${WIDTH}x${HEIGHT}`)
        .outputOptions([
          '-pix_fmt rgb24',
          '-preset ultrafast',
          '-tune fastdecode',
          '-threads 1',
          '-avoid_negative_ts make_zero',
          '-fflags +genpts',
          '-copyts',
          '-start_at_zero',
          '-vsync 0'  // Disable video sync to prevent stream issues
        ])
        .format('rawvideo')
        .on('start', (commandLine) => {
          // Optional: log command for debugging
          if (totalFramesProcessed % 100 == 0) {
            console.log('🎬 FFmpeg started for frame', currentFrame);
          }
        })
        .on('error', (err) => {
          if (processingTimeout) {
            clearTimeout(processingTimeout);
            processingTimeout = null;
          }
          
          console.error('💥 FFmpeg error:', err.message);
          console.error(`❌ Failed at frame ${currentFrame}, seek time: ${seekTime}s`);
          
          consecutiveErrors++;
          isProcessing = false;
          currentFFmpegProcess = null;
          
          // Exponential backoff on errors
          const delay = Math.min(5000, 200 * Math.pow(1.5, consecutiveErrors));
          
          // If too many consecutive errors, try skipping ahead
          if (consecutiveErrors >= 3) {  // Reduced from 5 to 3
            console.warn('🔄 Too many errors, skipping ahead...');
            currentFrame = (currentFrame + 2) % Math.floor(videoDuration * FPS);  // Skip less frames
            consecutiveErrors = 0;
          }
          
          setTimeout(processFrame, delay);
        })
        .pipe(outputStream);
        
    } catch (err) {
      console.error('Error creating FFmpeg process:', err);
      killCurrentProcess();
      isProcessing = false;
      setTimeout(processFrame, 1000);
    }
  };
  
  // Start processing
  console.log('🚀 Starting robust video processing...');
  processFrame();
};

// Start processing after short delay
setTimeout(startRobustProcessing, 1000);

// CLEANUP on process exit
process.on('SIGTERM', killCurrentProcess);
process.on('SIGINT', killCurrentProcess);
process.on('exit', killCurrentProcess);

// API endpoints
app.get('/frame', (req, res) => {
  res.header('Cache-Control', 'no-cache');
  res.json({
    pixels: lastPixels,
    frame: currentFrame,
    timestamp: currentFrame / FPS,
    width: WIDTH,
    height: HEIGHT,
    processingTime: Math.round(avgProcessingTime),
    totalFrames: totalFramesProcessed
  });
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
    restartCount
  });
});

app.get('/health', (req, res) => {
  const health = {
    status: avgProcessingTime < 3000 ? 'healthy' : 'degraded',
    avgProcessingTime: Math.round(avgProcessingTime),
    consecutiveErrors,
    totalFramesProcessed,
    restartCount,
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH)
  };
  
  res.status(health.status === 'healthy' ? 200 : 503).json(health);
});

app.get('/', (req, res) => {
  res.json({
    status: '🛡️ Robust High-Res Video Server',
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
      status: avgProcessingTime < 3000 ? '✅ healthy' : '⚠️ degraded'
    },
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH)
  });
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Robust video server running at http://0.0.0.0:${PORT}`);
  console.log(`📈 Performance monitoring enabled`);
  console.log(`🔄 Auto-restart on degradation enabled`);
});
