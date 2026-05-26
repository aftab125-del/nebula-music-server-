const express = require('express');
const cors = require('cors');
const { exec } = require('child_process');
const { promisify } = require('util');

const execAsync = promisify(exec);
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// Health check
app.get('/', (req, res) => {
  res.json({ status: 'NebulaMusic Server is running!' });
});

// Get audio stream URL from YouTube video ID
app.get('/audio/:videoId', async (req, res) => {
  const { videoId } = req.params;
  
  try {
    console.log(`[Server] Getting audio for video: ${videoId}`);
    
    const url = `https://www.youtube.com/watch?v=${videoId}`;
    
    // Use yt-dlp to get the best audio stream URL
    const command = `yt-dlp -f "bestaudio[ext=m4a]/bestaudio/best" --get-url --extractor-args "youtube:player_client=android" --no-check-certificates "${url}"`;
    
    const { stdout, stderr } = await execAsync(command, { timeout: 30000 });
    
    const streamUrl = stdout.trim();
    
    if (!streamUrl) {
      throw new Error('No stream URL returned');
    }
    
    console.log(`[Server] Successfully got stream URL`);
    
    res.json({
      url: streamUrl,
      videoId: videoId
    });
    
  } catch (error) {
    console.error(`[Server] Error:`, error.message);
    res.status(500).json({ error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`NebulaMusic Server running on port ${PORT}`);
});