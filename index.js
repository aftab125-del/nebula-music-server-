const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

// Copy cookies from read-only /etc/secrets/ to writable /tmp/ at startup
const SECRET_COOKIES = '/etc/secrets/cookies.txt';
const COOKIES_PATH = '/tmp/cookies.txt';
try {
  if (fs.existsSync(SECRET_COOKIES)) {
    fs.copyFileSync(SECRET_COOKIES, COOKIES_PATH);
    console.log('[Server] Cookies copied from /etc/secrets/ to /tmp/');
  } else {
    console.warn('[Server] No cookies file found at /etc/secrets/cookies.txt');
  }
} catch (err) {
  console.error('[Server] Failed to copy cookies:', err.message);
}

// --- Server-side cache setup ---
const CACHE_DIR = '/tmp/audio-cache';
if (!fs.existsSync(CACHE_DIR)) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
}
const getCachePath = (videoId) => path.join(CACHE_DIR, `${videoId}.m4a`);

// Tracks in-progress downloads so concurrent requests for the same song
// wait for the same download instead of starting duplicate yt-dlp calls.
const inFlightDownloads = new Map();

function downloadToCache(videoId) {
  if (inFlightDownloads.has(videoId)) {
    return inFlightDownloads.get(videoId);
  }

  const cachePath = getCachePath(videoId);
  const tempPath = `${cachePath}.tmp`;
  const url = `https://www.youtube.com/watch?v=${videoId}`;

  const downloadPromise = new Promise((resolve, reject) => {
    console.log(`[Cache] Downloading and caching: ${videoId}`);
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--cookies', COOKIES_PATH,
      '--no-check-certificates',
      '--extractor-args', 'youtube:player_client=web',
      '--remote-components', 'ejs:github',
      '-o', tempPath,
      url
    ]);

    ytdlp.stderr.on('data', (data) => {
      console.log(`[yt-dlp]: ${data}`);
    });

    ytdlp.on('close', (code) => {
      if (code === 0 && fs.existsSync(tempPath) && fs.statSync(tempPath).size > 0) {
        fs.renameSync(tempPath, cachePath);
        console.log(`[Cache] Cached successfully: ${videoId}`);
        resolve(cachePath);
      } else {
        if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
        reject(new Error(`yt-dlp exited with code ${code}`));
      }
    });

    ytdlp.on('error', (error) => {
      if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
      reject(error);
    });
  });

  inFlightDownloads.set(videoId, downloadPromise);
  downloadPromise.finally(() => inFlightDownloads.delete(videoId));

  return downloadPromise;
}

app.use(cors());
app.use(express.json());
app.get('/', (req, res) => {
  res.json({ status: 'NebulaMusic Server is running!' });
});

// Stream audio - serves from cache if available, otherwise downloads and caches
app.get('/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;

  try {
    const cachePath = getCachePath(videoId);

    // Serve directly from cache if it already exists
    if (fs.existsSync(cachePath)) {
      console.log(`[Server] Serving from cache: ${videoId}`);
      res.setHeader('Content-Type', 'audio/mp4');
      res.setHeader('Access-Control-Allow-Origin', '*');
      fs.createReadStream(cachePath).pipe(res);
      return;
    }

    console.log(`[Server] Not cached, downloading: ${videoId}`);
    await downloadToCache(videoId);

    // Now serve the freshly cached file
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Access-Control-Allow-Origin', '*');
    fs.createReadStream(cachePath).pipe(res);

  } catch (error) {
    console.error(`[Server] Error:`, error.message);
    if (!res.headersSent) {
      res.status(500).json({ error: error.message });
    }
  }
});

// Get audio URL (kept as backup)
app.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio/best" --get-url --cookies ${COOKIES_PATH} --no-check-certificates --extractor-args "youtube:player_client=web" --remote-components "ejs:github" "${url}"`;
    const { stdout } = await execAsync(command, { timeout: 30000 });
    const streamUrl = stdout.trim();
    if (!streamUrl) throw new Error('No stream URL returned');
    res.json({ url: streamUrl, videoId: videoId });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`NebulaMusic Server running on port ${PORT}`);
});