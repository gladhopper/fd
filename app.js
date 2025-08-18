const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');

ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;
const VIDEO_PATH = '/app/s.mp4';

// Configuration
const FPS = 10; // Target 10 FPS
const WIDTH = 320; // Higher resolution
const HEIGHT = 240;
const FRAME_INTERVAL = 1000 / FPS; // 100ms per frame

let currentFrame = 0;
let videoDuration = 0;
let lastPixels = [];
let isProcessing = false;

// Performance tracking
let avgProcessingTime = 100;
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let lastSuccessfulFrame = 0;

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

// Process management
let processingTimeout = null;
let currentFFmpegProcess = null;

const safeKillProcess = () => {
  if (processingTimeout) {
    clearTimeout(processingTimeout);
    processingTimeout = null;
  }
  
  if (currentFFmpegProcess) {
    try {
      currentFFmpegProcess.kill('SIGTERM');
      setTimeout(() => {
        try {
          currentFFmpegProcess.kill('SIGKILL');
        } catch (e) {}
        currentFFmpegProcess = null;
      }, 500);
    } catch (e) {
      console.warn('Process cleanup error:', e.message);
    }
  }
};

// Frame processing
const processFrame = async () => {
  if (isProcessing) return;
  isProcessing = true;
  const frameStart = Date.now();
  const seekTime = currentFrame / FPS;

  if (seekTime >= videoDuration || !isFinite(seekTime)) {
    currentFrame = 0; // Loop back to start
    isProcessing = false;
    setTimeout(processFrame, FRAME_INTERVAL);
    return;
  }

  processingTimeout = setTimeout(() => {
    console.warn(`⏰ Frame ${currentFrame} timeout (${seekTime.toFixed(2)}s)`);
    safeKillProcess();
    consecutiveErrors++;
    isProcessing = false;
    currentFrame = (currentFrame + 1) % Math.floor(videoDuration * FPS);
    setTimeout(processFrame, FRAME_INTERVAL);
  }, 1500); // Shorter timeout for faster FPS

  let pixelBuffer = Buffer.alloc(0);
  const outputStream = new PassThrough();
  let streamEnded = false;

  const handleSuccess = () => {
    if (streamEnded) return;
    streamEnded = true;
    clearTimeout(processingTimeout);
    processingTimeout = null;

    try {
      const pixels = [];
      const expectedSize = WIDTH * HEIGHT * 3;
      if (pixelBuffer.length < expectedSize) {
        const padding = Buffer.alloc(expectedSize - pixelBuffer.length, 0);
        pixelBuffer = Buffer.concat([pixelBuffer, padding]);
      }

      for (let i = 0; i < expectedSize; i += 3) {
        pixels.push([pixelBuffer[i] || 0, pixelBuffer[i + 1] || 0, pixelBuffer[i + 2] || 0]);
      }

      lastPixels = pixels;
      lastSuccessfulFrame = currentFrame;
      currentFrame = (currentFrame + 1) % Math.floor(videoDuration * FPS);
      totalFramesProcessed++;
      consecutiveErrors = Math.max(0, consecutiveErrors - 1);
      isProcessing = false;
      currentFFmpegProcess = null;

      const processingTime = Date.now() - frameStart;
      avgProcessingTime = (avgProcessingTime * 0.9) + (processingTime * 0.1);

      if (totalFramesProcessed % 50 === 0) {
        console.log(`✅ Frame ${lastSuccessfulFrame}: ${processingTime}ms (avg: ${Math.round(avgProcessingTime)}ms)`);
      }

      const elapsed = Date.now() - frameStart;
      const nextDelay = Math.max(0, FRAME_INTERVAL - elapsed);
      setTimeout(processFrame, nextDelay);
    } catch (err) {
      console.error('Success handler error:', err);
      isProcessing = false;
      setTimeout(processFrame, FRAME_INTERVAL);
    }
  };

  const handleError = (err) => {
    if (streamEnded) return;
    streamEnded = true;
    safeKillProcess();
    console.error(`💥 FFmpeg error at frame ${currentFrame} (${seekTime.toFixed(2)}s):`, err.message);
    consecutiveErrors++;
    isProcessing = false;
    currentFrame = (currentFrame + 1) % Math.floor(videoDuration * FPS);
    setTimeout(processFrame, FRAME_INTERVAL);
  };

  outputStream.on('data', chunk => {
    pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
  });
  outputStream.on('end', handleSuccess);
  outputStream.on('error', handleError);

  if (!fs.existsSync(VIDEO_PATH)) {
    console.error('❌ Video file missing');
    handleError(new Error('Video file not found'));
    return;
  }

  try {
    currentFFmpegProcess = ffmpeg(VIDEO_PATH)
      .seekInput(seekTime)
      .frames(1)
      .size(`${WIDTH}x${HEIGHT}`)
      .outputOptions([
        '-pix_fmt rgb24',
        '-vf', `scale=${WIDTH}:${HEIGHT}:flags=fast_bilinear`,
        '-preset ultrafast',
        '-tune zerolatency',
        '-an',
        '-sn',
        '-dn'
      ])
      .format('rawvideo')
      .on('error', handleError)
      .pipe(outputStream, { end: true });
  } catch (err) {
    handleError(err);
  }
};

// Start processing
setTimeout(() => {
  console.log('🚀 Starting video processing at 10 FPS...');
  processFrame();
}, 1000);

// Cleanup
const cleanup = () => {
  console.log('🧹 Cleaning up...');
  safeKillProcess();
};

process.on('SIGTERM', cleanup);
process.on('SIGINT', cleanup);
process.on('exit', cleanup);

// API endpoints
app.get('/frame', (req, res) => {
  res.header('Cache-Control', 'no-cache, no-store, must-revalidate');
  res.json({
    pixels: lastPixels,
    frame: lastSuccessfulFrame,
    timestamp: lastSuccessfulFrame / FPS,
    width: WIDTH,
    height: HEIGHT,
    avgProcessingTime: Math.round(avgProcessingTime)
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
    lastSuccessfulFrame
  });
});

app.get('/health', (req, res) => {
  const isHealthy = consecutiveErrors < 3 && avgProcessingTime < 500 && fs.existsSync(VIDEO_PATH);
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'degraded',
    avgProcessingTime: Math.round(avgProcessingTime),
    consecutiveErrors,
    totalFramesProcessed,
    isProcessing,
    fileExists: fs.existsSync(VIDEO_PATH),
    lastSuccessfulFrame,
    uptime: process.uptime()
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🛡️ Video server running at http://0.0.0.0:${PORT}`);
});
