const DEFAULT_TIMEOUT_MS = 15000;
const TOKEN_SAFETY_WINDOW_MS = 30 * 1000;
const MAX_TRIGGER_ATTEMPTS = 3;

let cachedToken;

function getRequiredEnv(name) {
	const value = process.env[name];
	if (!value) {
		throw new Error(`Missing required environment variable: ${name}`);
	}
	return value;
}

function normalizeBaseUrl(url) {
	return url.endsWith('/') ? url.slice(0, -1) : url;
}

function getTimeoutMs() {
	const timeout = Number(process.env.OIC_TIMEOUT_MS || DEFAULT_TIMEOUT_MS);
	return Number.isFinite(timeout) && timeout > 0 ? timeout : DEFAULT_TIMEOUT_MS;
}

function isCachedTokenValid() {
	return cachedToken && cachedToken.accessToken && (Date.now() + TOKEN_SAFETY_WINDOW_MS) < cachedToken.expiresAt;
}

function parseMaybeJson(body) {
	if (!body) {
		return null;
	}

	try {
		return JSON.parse(body);
	} catch {
		return null;
	}
}

function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRetryDelayMs(attempt, response) {
	const retryAfter = response?.headers?.get?.('retry-after');
	if (retryAfter) {
		const parsed = Number(retryAfter);
		if (Number.isFinite(parsed) && parsed > 0) {
			return parsed * 1000;
		}
	}

	return Math.min(1000 * (2 ** (attempt - 1)), 5000);
}

function isRetryableStatus(status) {
	return status === 429 || status >= 500;
}

function buildTokenUrl() {
	if (process.env.OIC_TOKEN_URL) {
		return process.env.OIC_TOKEN_URL;
	}

	const idcsBaseUrl = getRequiredEnv('OIC_IDCS_BASE_URL');
	return `${normalizeBaseUrl(idcsBaseUrl)}/oauth2/v1/token`;
}

async function fetchWithTimeout(url, options = {}) {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), getTimeoutMs());

	try {
		return await fetch(url, {
			...options,
			signal: controller.signal,
		});
	} catch (error) {
		if (error?.name === 'AbortError') {
			throw new Error(`Request timed out after ${getTimeoutMs()}ms: ${url}`);
		}
		throw error;
	} finally {
		clearTimeout(timeout);
	}
}

async function getAccessToken(forceRefresh = false) {
	const staticAccessToken = process.env.OIC_ACCESS_TOKEN;
	if (staticAccessToken && !forceRefresh) {
		return staticAccessToken;
	}

	if (!forceRefresh && isCachedTokenValid()) {
		return cachedToken.accessToken;
	}

	const clientId = getRequiredEnv('OIC_CLIENT_ID');
	const clientSecret = getRequiredEnv('OIC_CLIENT_SECRET');
	const refreshToken = getRequiredEnv('OIC_REFRESH_TOKEN');
	const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
	const tokenUrl = buildTokenUrl();

	const form = new URLSearchParams({
		grant_type: 'refresh_token',
		refresh_token: refreshToken,
	});

	const scope = process.env.OIC_SCOPE;
	if (scope) {
		form.append('scope', scope);
	}

	const response = await fetchWithTimeout(tokenUrl, {
		method: 'POST',
		headers: {
			Authorization: `Basic ${basicAuth}`,
			'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8',
			Accept: 'application/json',
		},
		body: form,
	});

	const responseText = await response.text();
	const responseJson = parseMaybeJson(responseText);

	if (!response.ok) {
		throw new Error(`OAuth token request failed (${response.status}): ${responseText.slice(0, 600)}`);
	}

	const accessToken = responseJson?.access_token;
	const expiresIn = Number(responseJson?.expires_in || 3600);

	if (!accessToken) {
		throw new Error('OAuth token response did not include access_token');
	}

	cachedToken = {
		accessToken,
		expiresAt: Date.now() + (expiresIn * 1000),
	};

	return accessToken;
}

function buildOicHeaders(accessToken) {
	const headers = {
		Authorization: `Bearer ${accessToken}`,
		'Content-Type': 'application/json',
		Accept: 'application/json',
	};

	const tenantName = process.env.OIC_TENANT_NAME;
	if (tenantName) {
		headers['X-ID-TENANT-NAME'] = tenantName;
	}

	return headers;
}

async function postTrigger(payload, accessToken) {
	const triggerUrl = getRequiredEnv('OIC_TRIGGER_URL');

	const response = await fetchWithTimeout(triggerUrl, {
		method: 'POST',
		headers: buildOicHeaders(accessToken),
		body: JSON.stringify(payload),
	});

	const responseText = await response.text();
	return { response, responseText };
}

async function callOICIntegrationTrigger(payload) {
	if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
		throw new Error('payload must be a JSON object');
	}

	let accessToken = await getAccessToken(false);

	for (let attempt = 1; attempt <= MAX_TRIGGER_ATTEMPTS; attempt += 1) {
		let { response, responseText } = await postTrigger(payload, accessToken);

		if (response.status === 401) {
			accessToken = await getAccessToken(true);
			({ response, responseText } = await postTrigger(payload, accessToken));
		}

		if (response.ok) {
			return {
				status: response.status,
				ok: true,
				body: parseMaybeJson(responseText) ?? responseText,
			};
		}

		if (!isRetryableStatus(response.status) || attempt === MAX_TRIGGER_ATTEMPTS) {
			throw new Error(`OIC trigger request failed (${response.status}): ${responseText.slice(0, 1200)}`);
		}

		await sleep(getRetryDelayMs(attempt, response));
	}

	throw new Error('OIC trigger request failed after retries');
}

module.exports = { callOICIntegrationTrigger };