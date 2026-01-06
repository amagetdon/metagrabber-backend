const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

const app = express();
app.use(cors());
app.use(express.json());

const PORT = process.env.PORT || 3000;

// Instagram 다운로드
async function downloadInstagram(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--single-process',
    ],
  });

  const results = [];

  try {
    const page = await browser.newPage();

    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    // 네트워크 요청 모니터링
    const videoUrls = new Set();

    page.on('response', async (response) => {
      const url = response.url();
      if (url.includes('.mp4') || url.includes('video') && url.includes('cdninstagram')) {
        videoUrls.add(url);
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    // 비디오 요소에서 src 추출
    const videoSrc = await page.evaluate(() => {
      const video = document.querySelector('video');
      if (video) {
        return video.src || video.querySelector('source')?.src;
      }
      return null;
    });

    if (videoSrc) {
      results.push({ type: 'video', url: videoSrc, quality: 'HD' });
    }

    // 네트워크에서 캡처된 비디오 URL 추가
    for (const vUrl of videoUrls) {
      if (!results.find(r => r.url === vUrl)) {
        results.push({ type: 'video', url: vUrl, quality: 'HD' });
      }
    }

    // 이미지 추출 (비디오 없을 경우)
    if (results.length === 0) {
      const images = await page.evaluate(() => {
        const imgs = [];
        document.querySelectorAll('img').forEach(img => {
          if (img.src && img.src.includes('cdninstagram') && img.width > 300) {
            imgs.push(img.src);
          }
        });
        return imgs;
      });

      for (const imgUrl of images) {
        results.push({ type: 'image', url: imgUrl });
      }
    }

    // og:video 메타 태그 확인
    const ogVideo = await page.evaluate(() => {
      const meta = document.querySelector('meta[property="og:video"]');
      return meta ? meta.content : null;
    });

    if (ogVideo && !results.find(r => r.url === ogVideo)) {
      results.push({ type: 'video', url: ogVideo, quality: 'HD' });
    }

  } catch (error) {
    console.error('Instagram error:', error.message);
  } finally {
    await browser.close();
  }

  return results;
}

// YouTube 다운로드
async function downloadYouTube(url) {
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

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
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

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
