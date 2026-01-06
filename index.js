const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer-core');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 8080;
const BROWSERLESS_TOKEN = process.env.BROWSERLESS_TOKEN;

// Browserless.io 사용
async function getBrowser() {
  if (BROWSERLESS_TOKEN) {
    return puppeteer.connect({
      browserWSEndpoint: `wss://chrome.browserless.io?token=${BROWSERLESS_TOKEN}`,
    });
  }
  // 로컬 폴백
  return puppeteer.launch({
    headless: 'new',
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/usr/bin/google-chrome-stable',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });
}

// Instagram 다운로드
async function downloadInstagram(url) {
  const results = [];
  let browser;

  try {
    // shortcode 추출
    const shortcode = url.match(/\/(p|reel|reels|tv)\/([A-Za-z0-9_-]+)/)?.[2];
    if (!shortcode) {
      console.error('Invalid Instagram URL');
      return results;
    }

    console.log('Connecting to browser...');
    browser = await getBrowser();
    console.log('Browser connected');

    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 네트워크 요청 모니터링
    const videoUrls = new Set();

    page.on('response', async (response) => {
      const resUrl = response.url();
      if (resUrl.includes('.mp4') || (resUrl.includes('video') && resUrl.includes('cdninstagram'))) {
        console.log('Found video URL:', resUrl.substring(0, 100));
        videoUrls.add(resUrl);
      }
    });

    // embed 페이지 사용 (로그인 불필요)
    const embedUrl = `https://www.instagram.com/p/${shortcode}/embed/`;
    console.log('Going to:', embedUrl);

    await page.goto(embedUrl, { waitUntil: 'networkidle0', timeout: 20000 });
    console.log('Page loaded');

    // 비디오 요소에서 src 추출
    const videoSrc = await page.evaluate(() => {
      const video = document.querySelector('video');
      return video ? (video.src || video.querySelector('source')?.src) : null;
    });

    if (videoSrc) {
      results.push({ type: 'video', url: videoSrc, quality: 'HD' });
    }

    // 네트워크에서 캡처된 비디오 URL
    for (const vUrl of videoUrls) {
      if (!results.find(r => r.url === vUrl)) {
        results.push({ type: 'video', url: vUrl, quality: 'HD' });
      }
    }

    // 이미지 추출
    if (results.length === 0) {
      const imageData = await page.evaluate(() => {
        const img = document.querySelector('.EmbeddedMediaImage') ||
                    document.querySelector('img[src*="cdninstagram"]');
        return img ? img.src : null;
      });

      if (imageData) {
        results.push({ type: 'image', url: imageData });
      }
    }

    console.log('Results:', results.length);

  } catch (error) {
    console.error('Instagram error:', error.message);
  } finally {
    if (browser) {
      await browser.close();
      console.log('Browser closed');
    }
  }

  return results;
}

// YouTube 다운로드
async function downloadYouTube(url) {
  const browser = await getBrowser();

  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 });

    // ytInitialPlayerResponse에서 스트림 정보 추출
    const videoData = await page.evaluate(() => {
      if (window.ytInitialPlayerResponse) {
        const data = window.ytInitialPlayerResponse;
        const formats = [
          ...(data.streamingData?.formats || []),
          ...(data.streamingData?.adaptiveFormats || []),
        ];

        const videos = formats
          .filter(f => f.url && f.mimeType?.includes('video'))
          .map(f => ({
            url: f.url,
            quality: f.qualityLabel || f.quality,
            mimeType: f.mimeType,
          }));

        return {
          title: data.videoDetails?.title,
          thumbnail: data.videoDetails?.thumbnail?.thumbnails?.slice(-1)[0]?.url,
          videos,
        };
      }
      return null;
    });

    if (videoData) {
      for (const v of videoData.videos) {
        results.push({
          type: 'video',
          url: v.url,
          quality: v.quality,
          title: videoData.title,
        });
      }
      if (videoData.thumbnail) {
        results.push({ type: 'image', url: videoData.thumbnail, title: videoData.title });
      }
    }

  } catch (error) {
    console.error('YouTube error:', error.message);
  } finally {
    await browser.close();
  }

  return results;
}

// Facebook 다운로드
async function downloadFacebook(url) {
  const browser = await getBrowser();

  const results = [];

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 네트워크 요청 모니터링
    const videoUrls = new Set();

    page.on('response', async (response) => {
      const resUrl = response.url();
      if (resUrl.includes('.mp4') || (resUrl.includes('video') && resUrl.includes('fbcdn'))) {
        videoUrls.add(resUrl);
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // 페이지에서 비디오 URL 추출
    const pageVideos = await page.evaluate(() => {
      const videos = [];

      // video 태그에서 src 추출
      document.querySelectorAll('video').forEach(v => {
        if (v.src) videos.push(v.src);
      });

      // JSON-LD에서 추출
      document.querySelectorAll('script[type="application/ld+json"]').forEach(script => {
        try {
          const data = JSON.parse(script.textContent);
          if (data.contentUrl) videos.push(data.contentUrl);
        } catch (e) {}
      });

      return videos;
    });

    for (const vUrl of [...pageVideos, ...videoUrls]) {
      if (!results.find(r => r.url === vUrl)) {
        results.push({ type: 'video', url: vUrl, quality: 'HD' });
      }
    }

  } catch (error) {
    console.error('Facebook error:', error.message);
  } finally {
    await browser.close();
  }

  return results;
}

// API 엔드포인트
app.post('/download', async (req, res) => {
  try {
    const { url } = req.body;

    if (!url) {
      return res.status(400).json({ error: 'URL is required' });
    }

    let results = [];

    if (url.includes('instagram.com')) {
      results = await downloadInstagram(url);
    } else if (url.includes('youtube.com') || url.includes('youtu.be')) {
      results = await downloadYouTube(url);
    } else if (url.includes('facebook.com') || url.includes('fb.com') || url.includes('fb.watch')) {
      results = await downloadFacebook(url);
    } else {
      return res.status(400).json({ error: 'Unsupported platform' });
    }

    const media = results.map((item, index) => ({
      ...item,
      filename: item.type === 'video'
        ? `video_${Date.now()}_${index}.mp4`
        : `image_${Date.now()}_${index}.jpg`,
    }));

    res.json({ success: true, media });
  } catch (error) {
    console.error('Error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
