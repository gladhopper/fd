const express = require('express');
const ffmpeg = require('fluent-ffmpeg');
const fs = require('fs');
const { PassThrough } = require('stream');
const path = require('path');

// Use system-installed FFmpeg (from Dockerfile)
ffmpeg.setFfmpegPath('/usr/bin/ffmpeg');
ffmpeg.setFfprobePath('/usr/bin/ffprobe');

const app = express();
const PORT = process.env.PORT || 8080;

// IMPORTANT: point to repo file (bundled with Docker image)
const VIDEO_PATH = '/app/s.mp4';

// ADD DEBUGGING BLOCK RIGHT HERE
console.log('=== DEBUGGING FILE EXISTENCE ===');
console.log('Current working directory:', process.cwd());
console.log('VIDEO_PATH:', VIDEO_PATH);

try {
  // List ALL files in /app
  console.log('All files in /app:', fs.readdirSync('/app'));
  
  // Check if the exact file exists
  console.log('Does VIDEO_PATH exist?', fs.existsSync(VIDEO_PATH));
  
  // If it exists, show file stats
  if (fs.existsSync(VIDEO_PATH)) {
    const stats = fs.statSync(VIDEO_PATH);
    console.log('File size:', stats.size);
    console.log('File permissions:', stats.mode.toString(8));
  }
  
  // Check if s.mp4 exists anywhere in /app
  const allFiles = fs.readdirSync('/app', { recursive: true });
  const mp4Files = allFiles.filter(f => f.includes('.mp4'));
  console.log('All MP4 files found:', mp4Files);
  
  // Try to access the file directly
  const testBuffer = fs.readFileSync(VIDEO_PATH, { flag: 'r' });
  console.log('File can be read, first 100 bytes:', testBuffer.slice(0, 100));
  
} catch (error) {
  console.error('Error during file system check:', error);
}
console.log('=== END DEBUG ===');

// 240p resolution (192x144) with synchronized playback
const FPS = 10;
const FRAME_INTERVAL = 1000 / FPS; // 100ms exactly
const WIDTH = 192;   // 240p width
const HEIGHT = 144;  // 240p height

let videoDuration = 0;
let lastPixels = [];
let isProcessing = false;
let consecutiveErrors = 0;

// SYNCHRONIZED VIDEO PLAYBACK - all servers get same timestamp
let videoStartTime = Date.now(); // When the video conceptually "started"
let lastFrameCache = null;
let cacheTimestamp = 0;

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  next();
});

// Get video duration
const getVideoDuration = () => {
  return new Promise((resolve) => {
    console.log('Getting video duration for:', VIDEO_PATH);
    ffmpeg.ffprobe(VIDEO_PATH, (err, metadata) => {
      if (err) {
        console.warn('ffprobe failed:', err);
        console.warn('Using fallback duration');
        resolve(60);
      } else {
        console.log('ffprobe successful, duration:', metadata.format.duration);
        resolve(metadata.format.duration);
      }
    });
  });
};

// Initialize duration
(async () => {
  try {
    videoDuration = await getVideoDuration();
    console.log(`Video duration: ${videoDuration}s`);
    console.log(`Total frames: ${Math.floor(videoDuration * FPS)}`);
    console.log(`Resolution: ${WIDTH}x${HEIGHT} (240p)`);
    console.log(`Synchronized playback: ${FPS} FPS`);
  } catch (err) {
    console.error('Could not get video duration:', err);
    videoDuration = 60;
  }
})();

// Calculate current synchronized timestamp
const getCurrentVideoTime = () => {
  if (!videoDuration) return 0;
  
  const elapsed = (Date.now() - videoStartTime) / 1000; // seconds since start
  const loopedTime = elapsed % videoDuration; // loop the video
  return loopedTime;
};

const getCurrentFrameNumber = () => {
  const videoTime = getCurrentVideoTime();
  return Math.floor(videoTime * FPS);
};

// Frame processing for synchronized playback
let activeFFmpegProcess = null;
let lastProcessedFrame = -1;

const processSynchronizedFrame = async (targetTime) => {
  if (isProcessing || consecutiveErrors > 5) {
    if (consecutiveErrors > 5) {
      console.log(`⏸️ Pausing due to ${consecutiveErrors} consecutive errors`);
      setTimeout(() => { consecutiveErrors = 0; }, 5000);
    }
    return null;
  }
  
  return new Promise((resolve) => {
    const frameStart = Date.now();
    isProcessing = true;
    
    let pixelBuffer = Buffer.alloc(0);
    const outputStream = new PassThrough();
    
    // Set up timeout for the stream
    const streamTimeout = setTimeout(() => {
      console.log('⚠️ Stream timeout, destroying stream');
      try {
        if (outputStream && !outputStream.destroyed) {
          outputStream.destroy();
        }
        if (activeFFmpegProcess) {
          // Use the fluent-ffmpeg kill method
          activeFFmpegProcess.kill();
        }
      } catch (err) {
        console.log('Error during timeout cleanup:', err.message);
      }
      consecutiveErrors++;
      isProcessing = false;
      activeFFmpegProcess = null;
      resolve(null);
    }, 2500); // Reduced to 2.5 seconds
    
    outputStream.on('data', chunk => {
      pixelBuffer = Buffer.concat([pixelBuffer, chunk]);
    });
    
    outputStream.on('end', () => {
      clearTimeout(streamTimeout);
      
      const pixels = [];
      for (let i = 0; i < pixelBuffer.length; i += 3) {
        pixels.push([pixelBuffer[i], pixelBuffer[i + 1], pixelBuffer[i + 2]]);
      }
      
      consecutiveErrors = 0; // Reset error counter on success
      isProcessing = false;
      
      const processingTime = Date.now() - frameStart;
      if (processingTime > 200) {
        console.log(`⚠️ Slow frame at ${targetTime.toFixed(2)}s: ${processingTime}ms`);
      } else {
        console.log(`✅ Frame at ${targetTime.toFixed(2)}s: ${processingTime}ms`);
      }
      
      resolve(pixels);
    });
    
    outputStream.on('error', (err) => {
      clearTimeout(streamTimeout);
      console.error('Stream error:', err.message);
      consecutiveErrors++;
      isProcessing = false;
      resolve(null);
    });
    
    // Pre-FFmpeg checks
    if (!fs.existsSync(VIDEO_PATH)) {
      console.error('❌ Video file missing at processing time:', VIDEO_PATH);
      consecutiveErrors++;
      isProcessing = false;
      clearTimeout(streamTimeout);
      resolve(null);
      return;
    }
    
    // Create FFmpeg process with optimized settings for 240p
    activeFFmpegProcess = ffmpeg(VIDEO_PATH)
      .seekInput(targetTime)
      .frames(1)
      .size(`${WIDTH}x${HEIGHT}`)
      .outputOptions([
        '-pix_fmt rgb24',
        '-preset ultrafast',
        '-tune fastdecode',
        '-threads 2', // Slightly more threads for 240p
        '-avoid_negative_ts make_zero'
      ])
      .format('rawvideo')
      .on('error', (err) => {
        clearTimeout(streamTimeout);
        
        if (err.message.includes('Output stream closed')) {
          console.error(`⚠️ Stream closed error at ${targetTime.toFixed(2)}s`);
        } else {
          console.error('FFmpeg error:', err.message);
        }
        
        consecutiveErrors++;
        isProcessing = false;
        activeFFmpegProcess = null;
        resolve(null);
      })
      .on('end', () => {
        activeFFmpegProcess = null;
      })
      .pipe(outputStream);
  });
};

// Background frame processing
const startSynchronizedProcessing = () => {
  setInterval(async () => {
    if (!videoDuration) return;
    
    const currentTime = getCurrentVideoTime();
    const currentFrame = getCurrentFrameNumber();
    
    // Only process if we need a new frame
    if (currentFrame === lastProcessedFrame) return;
    
    const pixels = await processSynchronizedFrame(currentTime);
    if (pixels) {
      lastPixels = pixels;
      lastFrameCache = {
        pixels: pixels,
        frame: currentFrame,
        timestamp: currentTime,
        serverTime: Date.now(),
        width: WIDTH,
        height: HEIGHT
      };
      cacheTimestamp = Date.now();
      lastProcessedFrame = currentFrame;
    }
  }, FRAME_INTERVAL / 2); // Check twice per frame for better sync
};

// Start processing after initialization
setTimeout(startSynchronizedProcessing, 1000);

// API endpoints with synchronized data
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
    synchronized: true
  });
});

app.get('/sync', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    currentTime: currentTime,
    currentFrame: currentFrame,
    serverTime: Date.now(),
    videoStartTime: videoStartTime,
    videoDuration: videoDuration,
    fps: FPS,
    synchronized: true
  });
});

app.get('/info', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    currentFrame: currentFrame,
    timestamp: currentTime,
    duration: videoDuration,
    fps: FPS,
    frameInterval: FRAME_INTERVAL,
    width: WIDTH,
    height: HEIGHT,
    totalFrames: Math.floor(videoDuration * FPS),
    isProcessing,
    consecutiveErrors,
    videoStartTime: videoStartTime,
    serverTime: Date.now(),
    synchronized: true
  });
});

app.get('/debug', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    videoPath: VIDEO_PATH,
    fileExists: fs.existsSync(VIDEO_PATH),
    workingDirectory: process.cwd(),
    filesInApp: fs.readdirSync('/app'),
    fileStats: fs.existsSync(VIDEO_PATH) ? fs.statSync(VIDEO_PATH) : null,
    currentFrame: currentFrame,
    currentTime: currentTime,
    videoDuration,
    isProcessing,
    fps: FPS,
    frameInterval: FRAME_INTERVAL,
    consecutiveErrors,
    resolution: `${WIDTH}x${HEIGHT}`,
    videoStartTime: videoStartTime,
    serverTime: Date.now(),
    synchronized: true
  });
});

app.get('/', (req, res) => {
  const currentTime = getCurrentVideoTime();
  const currentFrame = getCurrentFrameNumber();
  
  res.json({
    status: 'Synchronized Video Server - 240p @ 10 FPS',
    frame: currentFrame,
    timestamp: currentTime,
    duration: videoDuration,
    resolution: `${WIDTH}x${HEIGHT}`,
    fps: FPS,
    frameInterval: FRAME_INTERVAL,
    pixelsCount: lastPixels.length,
    isProcessing,
    consecutiveErrors,
    fileExists: fs.existsSync(VIDEO_PATH),
    videoStartTime: videoStartTime,
    serverTime: Date.now(),
    synchronized: true
  });
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('Shutting down gracefully...');
  try {
    if (activeFFmpegProcess) {
      activeFFmpegProcess.kill();
    }
  } catch (err) {
    console.log('Error during shutdown:', err.message);
  }
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('Shutting down gracefully...');
  try {
    if (activeFFmpegProcess) {
      activeFFmpegProcess.kill();
    }
  } catch (err) {
    console.log('Error during shutdown:', err.message);
  }
  process.exit(0);
});

// Listen on Koyeb-assigned port
app.listen(PORT, '0.0.0.0', () => {
  console.log(`Synchronized Video Server running at http://0.0.0.0:${PORT}`);
  console.log(`Debug endpoint available at http://0.0.0.0:${PORT}/debug`);
  console.log(`Sync endpoint available at http://0.0.0.0:${PORT}/sync`);
  console.log(`🎬 SYNCHRONIZED playback at ${FPS} FPS`);
  console.log(`📐 240p resolution: ${WIDTH}x${HEIGHT}`);
  console.log(`🕒 Video start time: ${new Date(videoStartTime).toISOString()}`);
});
