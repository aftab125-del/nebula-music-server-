const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');
const { spawn } = require('child_process');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

app.get('/', (req, res) => {
  res.json({ status: 'NebulaMusic Server is running!' });
});

// Stream audio directly from YouTube
app.get('/stream/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    console.log(`[Server] Streaming audio for video: ${videoId}`);
    
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    res.setHeader('Content-Type', 'audio/mp4');
    res.setHeader('Transfer-Encoding', 'chunked');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    const ytdlp = spawn('yt-dlp', [
      '-f', 'bestaudio[ext=m4a]/bestaudio/best',
      '--cookies', '/etc/secrets/cookies.txt',
      '--no-update-cookies',
      '--no-check-certificates',
      '-o', '-',
      url
    ]);
    
    ytdlp.stdout.pipe(res);
    
    ytdlp.stderr.on('data', (data) => {
      console.log(`[yt-dlp]: ${data}`);
    });
    
    ytdlp.on('error', (error) => {
      console.error(`[Server] Spawn error:`, error);
      if (!res.headersSent) {
        res.status(500).json({ error: error.message });
      }
    });
    
    req.on('close', () => {
      ytdlp.kill();
    });
    
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
    const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio/best" --get-url --cookies /etc/secrets/cookies.txt --no-update-cookies --no-check-certificates "${url}"`;
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