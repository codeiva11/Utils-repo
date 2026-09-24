const fs = require('fs');
const https = require('https');
const axios = require('axios');

const FILE_PATH = 'urls.json';

function urlsJson() {
  try {
    const data = fs.readFileSync(FILE_PATH, 'utf8');
    return JSON.parse(data);
  } catch (error) {
    console.error(`Error reading ${FILE_PATH}:`, error);
    process.exit(1);
  }
}

function getDomain(url) {
  try {
    const urlObj = new URL(url);
    return urlObj.origin;
  } catch (error) {
    console.error(`Error parsing URL ${url}:`, error);
    return url;
  }
}

function hasTrailingSlash(url) {
  return url.endsWith('/') && !url.endsWith('://');
}

// Known ad / tracking / spam domains to never treat as redirect destinations
const AD_AND_TRACKER_DOMAINS = new Set([
  'bonuscaf.com', 'clickhubz.com', 'adshort.co', 'shrinkme.io',
  'linkvertise.com', 'ouo.io', 'ouo.press', 'bit.ly', 'tinyurl.com',
  'shorte.st', 'adf.ly', 'za.gl', 'bc.vc', 'exe.io',
  'gplinks.co', 'shrinkforearn.in', 'techymozo.com',
  'adrinolinks.in', 'link1s.com', 'earnhub.net'
]);

function isAdOrTracker(domainOrUrl) {
  try {
    const hostname = (domainOrUrl.startsWith('http') ? new URL(domainOrUrl).hostname : domainOrUrl).toLowerCase();
    for (const adDomain of AD_AND_TRACKER_DOMAINS) {
      if (hostname === adDomain || hostname.endsWith('.' + adDomain)) {
        return true;
      }
    }
  } catch (e) {
    // ignore parse error
  }
  return false;
}

// Custom resolver for HDHub4u client-side domain resolution API
async function resolveHDHub4u(client) {
  const endpoints = [
    'https://h4.suncdn.org/host/',
    'https://ml.theapii.org/host/',
    'https://points.topapii.com/host/',
    'https://dns.pingora.fyi/v2/host'
  ];
  const t = new Date();
  const o = 1e6 * t.getFullYear() + 1e4 * (t.getMonth() + 1) + 100 * t.getDate() + t.getHours() + 1;

  for (const ep of endpoints) {
    try {
      const resp = await client.get(`${ep}?v=1a${o}`, { timeout: 8000 });
      if (resp.status === 200 && resp.data && resp.data.c) {
        const decoded = Buffer.from(resp.data.c, 'base64').toString('utf8');
        const targetDomain = getDomain(decoded);
        if (targetDomain && !isAdOrTracker(targetDomain)) {
          console.log(`🎯 [hdhub4u] Resolved active domain via API (${ep}): ${targetDomain}`);
          return targetDomain;
        }
      }
    } catch (e) {
      // try next endpoint
    }
  }
  return null;
}

// Custom resolver for landing-page providers (e.g., BollyFlix with ?re=)
async function resolveLandingPage(name, url, html, client) {
  // Pattern 0: HDHub4u special resolution
  if (name === 'hdhub4u') {
    const hdhubTarget = await resolveHDHub4u(client);
    if (hdhubTarget && hdhubTarget !== getDomain(url)) {
      return hdhubTarget;
    }
  }
  if (name === 'bollyflix' || html.includes('?re=')) {
    const reMatch = html.match(/href=["'](\?re=[^"']+)["']/i);
    if (reMatch) {
      const reUrl = new URL(reMatch[1], url).toString();
      try {
        const reResp = await client.get(reUrl, { maxRedirects: 0, validateStatus: () => true });
        const loc = reResp.headers.location;
        if (loc) {
          const finalDomain = getDomain(loc.startsWith('http') ? loc : new URL(loc, url).toString());
          if (!isAdOrTracker(finalDomain)) {
            console.log(`🎯 [${name}] Resolved landing-page ?re= redirect to: ${finalDomain}`);
            return finalDomain;
          }
        }
      } catch (e) {
        console.log(`⚠️ [${name}] Error following ?re=: ${e.message}`);
      }
    }
  }

  // Pattern 2: Meta refresh redirect: <meta http-equiv="refresh" content="0;url=...">
  const metaMatch = html.match(/<meta[^>]*http-equiv=["']?refresh["']?[^>]*content=["']?\d+;\s*url=([^"'>\s]+)/i);
  if (metaMatch && metaMatch[1]) {
    const target = metaMatch[1];
    const fullTarget = target.startsWith('http') ? target : new URL(target, url).toString();
    const finalDomain = getDomain(fullTarget);
    if (finalDomain !== getDomain(url) && !isAdOrTracker(finalDomain)) {
      console.log(`🎯 [${name}] Resolved meta-refresh to: ${finalDomain}`);
      return finalDomain;
    }
  }

  // Pattern 3: JavaScript redirects (window.location = "...", location.href = "...", location.replace("..."))
  // Ignore event listeners like onpopstate, onclick, etc., that trigger ads
  const cleanHtml = html.replace(/onpopstate[\s\S]*?}|addEventListener\s*\(\s*["'](?:popstate|click)["'][\s\S]*?}\s*\)/gi, '');
  const jsMatch = cleanHtml.match(/(?:window\.)?location(?:\.href|\.replace)?\s*(?:=|\()\s*["'](https?:\/\/[^"']+)["']/i);
  if (jsMatch && jsMatch[1]) {
    const target = jsMatch[1];
    const finalDomain = getDomain(target);
    if (finalDomain !== getDomain(url) && !isAdOrTracker(finalDomain)) {
      console.log(`🎯 [${name}] Resolved JS-redirect to: ${finalDomain}`);
      return finalDomain;
    }
  }

  return null;
}

// Follow standard 3xx redirect chain (up to 5 hops)
async function followRedirects(name, initialUrl, client) {
  let currentUrl = initialUrl;
  const visited = new Set([currentUrl]);

  for (let hop = 0; hop < 5; hop++) {
    try {
      const response = await client.get(currentUrl, {
        maxRedirects: 0,
        validateStatus: status => true
      });

        // Check for 3xx redirect
        if (response.status >= 300 && response.status < 400 && response.headers.location) {
          let next = response.headers.location;
          if (!next.startsWith('http')) {
            next = new URL(next, currentUrl).toString();
          }
          if (isAdOrTracker(next)) {
            console.log(`⚠️ [${name}] Ignored redirect to ad/tracker domain: ${next}`);
            break;
          }
          if (visited.has(next)) {
            console.log(`⚠️ [${name}] Redirect loop detected: ${next}`);
            break;
          }
        visited.add(next);
        console.log(`🔄 [${name}] ${currentUrl} -> (${response.status}) -> ${next}`);
        currentUrl = next;
        continue;
      }

      // Check for HTML-level redirect if status is 200
      if (response.status === 200 && typeof response.data === 'string') {
        const landingTarget = await resolveLandingPage(name, currentUrl, response.data, client);
        if (landingTarget && landingTarget !== getDomain(currentUrl)) {
          currentUrl = landingTarget;
          continue;
        }
      }

      // Terminal response reached
      break;
    } catch (e) {
      console.log(`⚠️ [${name}] Hop error on ${currentUrl}: ${e.message}`);
      break;
    }
  }

  return currentUrl;
}

async function checkUrl(name, url) {
  const client = axios.create({
    timeout: 12000,
    httpsAgent: new https.Agent({
      rejectUnauthorized: false
    }),
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
      'Referer': url
    }
  });

  const originalDomain = getDomain(url);

  // For hdhub4u, check official active domain resolver API first
  if (name === 'hdhub4u') {
    const apiTarget = await resolveHDHub4u(client);
    if (apiTarget && apiTarget !== originalDomain) {
      const trailing = hasTrailingSlash(url);
      const result = trailing ? `${apiTarget}/` : apiTarget;
      console.log(`✅ [${name}] Domain updated via official API: ${url} => ${result}`);
      return result;
    }
    if (apiTarget && apiTarget === originalDomain) {
      console.log(`ℹ️ [${name}] Domain matches active official API (${originalDomain})`);
      return null;
    }
  }

  const finalUrl = await followRedirects(name, url, client);
  const newDomain = getDomain(finalUrl);

  if (newDomain && newDomain !== originalDomain) {
    if (isAdOrTracker(newDomain)) {
      console.log(`⚠️ [${name}] Ignoring ad/tracker domain: ${newDomain}`);
      return null;
    }
    const trailing = hasTrailingSlash(url);
    const result = trailing ? `${newDomain}/` : newDomain;
    console.log(`✅ [${name}] Domain updated: ${url} => ${result}`);
    return result;
  }

  console.log(`ℹ️ [${name}] Domain unchanged (${originalDomain})`);
  return null;
}

module.exports = { checkUrl, urlsJson, getDomain };

if (require.main === module) {
  (async () => {
    const providers = urlsJson();
    let hasChanges = false;
    const SKIP_KEYS = new Set(['nfmirror']);

    for (const [name, url] of Object.entries(providers)) {
      if (SKIP_KEYS.has(name)) {
        console.log(`⏩ Skipping ${name} (${url}) as configured`);
        continue;
      }

      console.log(`Checking ${name} (${url})...`);
      try {
        const newUrl = await checkUrl(name, url);
        if (newUrl && newUrl !== url) {
          providers[name] = newUrl;
          hasChanges = true;
          console.log(`✏️ Updated ${name} URL from ${url} to ${newUrl}`);
        }
      } catch (error) {
        console.log(`❌ Error processing ${name} (${url}): ${error.message}`);
      }
    }

    if (hasChanges) {
      const jsonString = JSON.stringify(providers, null, 2);
      fs.writeFileSync(FILE_PATH, jsonString);
      console.log(`✅ Updated ${FILE_PATH} with new URLs`);
    } else {
      console.log(`ℹ️ No changes needed for ${FILE_PATH}`);
    }
  })().catch(error => {
    console.error('Unhandled error:', error);
    process.exit(1);
  });
}
