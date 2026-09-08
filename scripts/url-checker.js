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

// Custom resolver for landing-page providers (e.g., BollyFlix with ?re=)
async function resolveLandingPage(name, url, html, client) {
  // Pattern 1: BollyFlix style — landing page with ?re= query for full site
  if (name === 'bollyflix' || html.includes('?re=')) {
    const reMatch = html.match(/href=["'](\?re=[^"']+)["']/i);
    if (reMatch) {
      const reUrl = new URL(reMatch[1], url).toString();
      try {
        const reResp = await client.get(reUrl, { maxRedirects: 0, validateStatus: () => true });
        const loc = reResp.headers.location;
        if (loc) {
          const finalDomain = getDomain(loc.startsWith('http') ? loc : new URL(loc, url).toString());
          console.log(`🎯 [${name}] Resolved landing-page ?re= redirect to: ${finalDomain}`);
          return finalDomain;
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
    if (finalDomain !== getDomain(url)) {
      console.log(`🎯 [${name}] Resolved meta-refresh to: ${finalDomain}`);
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

  const finalUrl = await followRedirects(name, url, client);
  const originalDomain = getDomain(url);
  const newDomain = getDomain(finalUrl);

  if (newDomain && newDomain !== originalDomain) {
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
