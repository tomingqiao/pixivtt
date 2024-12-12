
addEventListener('fetch', event => {
    event.respondWith(handleRequest(event.request))
})

const credentials = {
    refresh_token: '',
    access_token: '',
    refresh_token_expiry: 0
}

const PIXIV_API_ENDPOINT = "app-api.pixiv.net"
const PIXIV_OAUTH_ENDPOINT = "oauth.secure.pixiv.net"

function _checkRequest(request) {
    const url = new URL(request.url);
    const mangaPattern = /^\/(\d+)-(\d+)$/;
    const singlePattern = /^\/(\d+)$/;

    let match;

    if ((match = mangaPattern.exec(url.pathname))) {
        return {
            is_valid: true,
            is_manga: true,
            pixiv_id: match[1],
            pixiv_page: match[2] - 1
        };
    } else if ((match = singlePattern.exec(url.pathname))) {
        return {
            is_valid: true,
            is_manga: false,
            pixiv_id: match[1]
        };
    } else {
        return {
            is_valid: false,
            is_manga: false
        };
    }
}

function _parseFilenameFromUrl(url) {
    return url.substring(url.lastIndexOf('/') + 1)
}

async function _getToken() {

    if (Date.now() > credentials.refresh_token_expiry) {
        const url = `https://${PIXIV_OAUTH_ENDPOINT}/auth/token`;
        const formData = new URLSearchParams({
            grant_type: 'refresh_token',
            refresh_token: credentials.refresh_token,
            client_id: 'MOBrBDS8blbauoSck0ZfDbtuzpyT',
            client_secret: 'lsACyCD94FhDUtGTXi3QzcFE2uU1hqtDaKeqrdwj',
            hash_secret: '28c1fdd170a5204386cb1313c7077b34f83e4aaf4aa829ce78c231e05b0bae2c'
        });

        const response = await fetch(url, {
            method: 'POST',
            headers: {
                'App-OS': 'ios',
                'App-OS-Version': '10.3.1',
                'App-Version': '6.7.1',
                'User-Agent': 'PixivIOSApp/6.7.1 (iOS 10.3.1; iPhone8,1)',
            },
            body: formData
        });

        const apiResult = await response.json();
        const { access_token, expires_in } = apiResult.response;

        // 更新凭证信息
        credentials.access_token = access_token;
        credentials.refresh_token_expiry = Date.now() + expires_in * 0.8 * 1000;

        return access_token;
    }

    return credentials.access_token;
}

async function _callPixivApi(url, token) {
    const cache = caches.default;

    // 构造通用 headers
    const commonHeaders = {
        'App-Version': '7.6.2',
        'App-OS-Version': '12.2',
        'App-OS': 'ios',
        'Accept': 'application/json',
        'User-Agent': 'PixivIOSApp/7.6.2 (iOS 12.2; iPhone9,1)'
    };

    // 缓存键
    const cacheKey = new Request(url, { method: 'GET', headers: commonHeaders });

    // 请求头（带 token）
    const authHeaders = { ...commonHeaders, Authorization: `Bearer ${token}` };
    const apiRequest = new Request(url, { method: 'GET', headers: authHeaders });

    // 检查缓存
    let cachedResponse = await cache.match(cacheKey);
    if (!cachedResponse) {
        const response = await fetch(apiRequest);

        // 存储到缓存
        cachedResponse = new Response(response.body, response);
        cachedResponse.headers.set('Cache-Control', 'max-age=3600'); // 缓存时间
        cachedResponse.headers.delete('Set-Cookie'); // 移除敏感信息
        await cache.put(cacheKey, cachedResponse.clone());
    }

    return cachedResponse.json();
}

async function _getImage(url) {
    const cache = caches.default;
    const cacheKey = new Request(new URL(url), {
        method: "GET",
        headers: {
            'Referer': 'http://www.pixiv.net/',
            'User-Agent': 'Cloudflare Workers',
        }
    })

    let cachedResponse = await cache.match(cacheKey)

    if (!cachedResponse) {
        const res = await fetch(cacheKey)
        cachedResponse = new Response(res.body, res)
        await cache.put(cacheKey, cachedResponse.clone())
    }

    return cachedResponse;
}

// 验证逻辑分离
function _validateRequest(checkRequest, illust) {
    if (checkRequest.is_manga === false) {
        // Normal mode validation
        if (illust.page_count > 1) {
            return '这个作品ID中有 ${illust.page_count} 张图片，需要指定页数才能正确显示。';
        }
    } else {
        // Manga mode validation
        if (checkRequest.pixiv_page < 0) {
            return '页数不得为0。';
        }
        if (illust.page_count === 1) {
            return '这个作品ID中只有一张图片，不需要指定是第几张图片。';
        }
        if (checkRequest.pixiv_page + 1 > illust.page_count) {
            return '这个作品ID中有 ${illust.page_count} 张图片，您指定的页数已超过这个作品ID中的页数。';
        }
    }
    return null; // Valid request
}

// 通用错误响应
function _errorResponse(message, status) {
    return new Response(message, { status });
}

// 构建图片响应
async function _buildImageResponse(imageUrl) {
    let image = await _getImage(imageUrl);
    image = new Response(image.body, image);
    image.headers.set('X-Origin-URL', imageUrl);
    image.headers.set('X-Access-Token-TS', credentials.refresh_token_expiry);
    image.headers.set(
        'Content-Disposition',
        'inline; filename="' + _parseFilenameFromUrl(imageUrl) + '"'
    );
    image.headers.delete('Via');
    return image;
}

async function handleRequest(request) {
    const checkRequest = _checkRequest(request);

    if (!checkRequest.is_valid) {
        return _errorResponse('404 Not Found', 404);
    }

    const token = await _getToken();
    const pixivApi = await _callPixivApi(
        'https://${PIXIV_API_ENDPOINT}/v1/illust/detail?illust_id=${checkRequest.pixiv_id}',
        token
    );

    if (pixivApi['error']) {
        return _errorResponse('这个作品可能已被删除，或无法取得。', 404);
    }

    const illust = pixivApi['illust'];
    const validationError = _validateRequest(checkRequest, illust);

    if (validationError) {
        return _errorResponse(validationError, 404);
    }

    // 根据模式返回图片
    const imageUrl = checkRequest.is_manga
        ? illust.meta_pages[checkRequest.pixiv_page].image_urls.original
        : illust.meta_single_page.original_image_url;

    return _buildImageResponse(imageUrl);
}

