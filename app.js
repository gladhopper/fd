const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs').promises;
const path = require('path');
const { PassThrough } = require('stream');

// Set FFmpeg paths (Koyeb container should have FFmpeg installed)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8000;

// Video file paths
const VIDEO_FILES = {
  'video.mp4': '/app/video.mp4',
  's.mp4': '/app/s.mp4'
};

// Default video
const DEFAULT_VIDEO = 's.mp4';

// Quality profiles (start with low to reduce resource usage)
const QUALITY_PROFILES = {
  low: { width: 160, height: 120, fps: 8, preset: 'ultrafast' },
  medium: { width: 160, height: 120, fps: 10, preset: 'veryfast' },
  high: { width: 160, height: 120, fps: 12, preset: 'fast' },
  ultra: { width: 160, height: 120, fps: 15, preset: 'medium' }
};

let currentProfile = 'low';
let { width: WIDTH, height: HEIGHT, fps: FPS, preset: PRESET } = QUALITY_PROFILES[currentProfile];
let FRAME_INTERVAL = 1000 / FPS;

const MAX_CONSECUTIVE_ERRORS = 5;
const QUALITY_ADJUSTMENT_THRESHOLD = 5;

// Video state
let videoStartTime = Date.now();
let videoDurations = {};
let lastPixels = [];
let consecutiveErrors = 0;
let totalFramesProcessed = 0;
let totalErrors = 0;
let lastProcessingTimes = [];
let performanceStats = {
  avgProcessingTime: 0,
  successRate: 0,
  lastSuccessTime: 0,
  memoryUsage: null,
  cpuUsage: null
};
let ffmpegInstance = null;

// Validate and get video duration
async function getVideoDuration(videoPath) {
  return new Promise((resolve) => {
    if (!fs.existsSync(videoPath)) {
      console.error(`❌ Video file not found: ${videoPath}`);
      resolve(300);
      return;
    }
    ffmpeg.ffprobe(videoPath, (err, metadata) => {
      if (err) {
        console.warn(`⚠️ ffprobe failed for ${videoPath}:`, err.message);
        resolve(300);
      } else {
        const duration = metadata.format.duration || 300;
        console.log(`✅ Video duration for ${videoPath}: ${duration}s`);
        resolve(duration);
      }
    });
  });
}

// Initialize video durations
(async () => {
  try {
    for (const [videoName, videoPath] of Object.entries(VIDEO_FILES)) {
      if (await fs.access(videoPath).then(() => true).catch(() => false)) {
        videoDurations[videoName] = await getVideoDuration(videoPath);
      } else {
        console.warn(`⚠️ Video file ${videoName} not found at ${videoPath}`);
        videoDurations[videoName] = 300;
      }
    }
    console.log(`🎥 Videos initialized:`, videoDurations);
  } catch (err) {
    console.error('❌ Failed to initialize videos:', err.message);
  }
})();

// Adaptive quality management
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
  FRAME_INTERVAL = 1000 / FPS;
  console.log(`🎥 New settings: ${WIDTH}x${HEIGHT} @ ${FPS}fps (${PRESET})`);
};

// Process single frame
const processSingleFrame = async (targetTime, videoName) => {
  const videoPath = VIDEO_FILES[videoName] || VIDEO_FILES[DEFAULT_VIDEO];
  return new Promise((resolve) => {
    console.log(`🎬 Processing frame at ${targetTime.toFixed(2)}s (${currentProfile}, ${videoName})`);
    const startTime = Date.now();
    let pixelBuffer = Buffer.alloc(0);
    let outputStream = new PassThrough();
    let streamEnded = false;

    const timeout = 3000; // Unified timeout to prevent FFmpeg errors
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
      if (!fs.existsSync(videoPath)) {
        console.error(`❌ Video file missing: ${videoPath}`);
        cleanup();
        resolve(null);
        return;
      }

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

      ffmpegInstance = ffmpeg(videoPath)
        .seekInput(Math.max(0, targetTime))
        .frames(1)
        .size(`${WIDTH}x${HEIGHT}`)
        .outputOptions([
          '-pix_fmt rgb24',
          `-preset ${PRESET}`,
          '-tune fastdecode',
          '-threads 1',
          '-re', // Real-time processing
          '-avoid_negative_ts make_zero',
          '-fflags +genpts+discardcorrupt',
          '-f rawvideo'
        ])
        .format('rawvideo')
        .on('start', (cmd) => {
          console.log('FFmpeg command:', cmd);
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

// Handle SIGTERM
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, cleaning up...');
  if (ffmpegInstance) {
    ffmpegInstance.kill('SIGTERM');
  }
  process.exit(0);
});

// CORS headers
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

// Processing loop
let isProcessing = false;
let lastSuccessfulTime = -1;

const processFrameLoop = async () => {
  if (!videoDurations[DEFAULT_VIDEO] || isProcessing) return;
  performanceStats.memoryUsage = process.memoryUsage();
  if (performanceStats.memoryUsage.heapUsed > 150 * 1024 * 1024) {
    adjustQuality('down');
    console.log('📉 Downgraded due to high memory usage');
  }
  if (consecutiveErrors >= MAX_CONSECUTIVE_ERRORS) {
    adjustQuality('down');
    consecutiveErrors = 0;
    const pauseTime = 5000;
    console.log(`⏸️ Pausing for ${pauseTime/1000}s due to errors`);
    await new Promise(resolve => setTimeout(resolve, pauseTime));
    return;
  }
  isProcessing = true;
  const currentTime = (Date.now() - videoStartTime) / 1000 % videoDurations[DEFAULT_VIDEO];
  if (Math.abs(currentTime - lastSuccessfulTime) < (1 / FPS)) {
    isProcessing = false;
    return;
  }
  const pixels = await processSingleFrame(currentTime, DEFAULT_VIDEO);
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
  } else {
    consecutiveErrors++;
    totalErrors++;
    console.log(`❌ Failed frame (${consecutiveErrors} consecutive errors)`);
  }
  isProcessing = false;
};

setInterval(processFrameLoop, FRAME_INTERVAL);

// Endpoints
app.get('/frame', async (req, res) => {
  const videoName = req.query.video || DEFAULT_VIDEO;
  const videoDuration = videoDurations[videoName] || 300;
  const currentTime = (Date.now() - videoStartTime) / 1000 % videoDuration;
  const pixels = await processSingleFrame(currentTime, videoName);
  res.json({
    pixels: pixels || lastPixels,
    frame: Math.floor(currentTime * FPS),
    timestamp: currentTime,
    width: WIDTH,
    height: HEIGHT,
    serverTime: Date.now(),
    videoStartTime,
    synchronized: true,
    quality: currentProfile
  });
});

app.get('/sync', (req, res) => {
  const videoName = req.query.video || DEFAULT_VIDEO;
  const videoDuration = videoDurations[videoName] || 300;
  res.json({
    currentTime: (Date.now() - videoStartTime) / 1000 % videoDuration,
    currentFrame: Math.floor(((Date.now() - videoStartTime) / 1000 % videoDuration) * FPS),
    serverTime: Date.now(),
    videoStartTime,
    videoDuration,
    fps: FPS,
    synchronized: true,
    quality: currentProfile,
    resolution: `${WIDTH}x${HEIGHT}`
  });
});

app.get('/health', (req, res) => {
  const isHealthy = Object.values(VIDEO_FILES).some(path => fs.existsSync(path)) &&
                    consecutiveErrors < MAX_CONSECUTIVE_ERRORS &&
                    Object.keys(videoDurations).length > 0;
  res.status(isHealthy ? 200 : 503).json({
    status: isHealthy ? 'healthy' : 'unhealthy',
    checks: {
      videosExist: Object.fromEntries(Object.entries(VIDEO_FILES).map(([name, path]) => [name, fs.existsSync(path)])),
      errorsUnderControl: consecutiveErrors < MAX_CONSECUTIVE_ERRORS,
      videoDurationsKnown: Object.keys(videoDurations).length > 0,
      recentSuccess: (Date.now() - performanceStats.lastSuccessTime) < 30000,
      memoryUsage: process.memoryUsage(),
      cpuUsage: process.cpuUsage()
    }
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`🌟 Video Server running at http://0.0.0.0:${PORT}`);
});
