import { NextRequest, NextResponse } from 'next/server';
import { isIP } from 'node:net';

const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const DEFAULT_ALLOWED_HOST_SUFFIXES = ['.licdn.com'];

function isPrivateOrLocalhost(hostname: string): boolean {
  const host = hostname.toLowerCase();

  if (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    host.endsWith('.internal') ||
    host.endsWith('.lan')
  ) {
    return true;
  }

  const ipVersion = isIP(host);
  if (!ipVersion) return false;

  if (ipVersion === 4) {
    const [a, b] = host.split('.').map((part) => parseInt(part, 10));
    if (a === 10) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 192 && b === 168) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    return false;
  }

  // IPv6
  if (host === '::1') return true;
  if (host.startsWith('fe80:')) return true; // link-local
  if (host.startsWith('fc') || host.startsWith('fd')) return true; // unique local
  return false;
}

function getAllowedImageHosts(): { hosts: Set<string>; suffixes: string[] } {
  const env = process.env.IMAGE_PROXY_ALLOWED_HOSTS;
  if (!env) {
    return { hosts: new Set(), suffixes: DEFAULT_ALLOWED_HOST_SUFFIXES };
  }

  const hosts = new Set<string>();
  const suffixes: string[] = [];

  for (const raw of env.split(',')) {
    const entry = raw.trim().toLowerCase();
    if (!entry) continue;
    if (entry.startsWith('.')) {
      suffixes.push(entry);
    } else {
      hosts.add(entry);
    }
  }

  return { hosts, suffixes: suffixes.length > 0 ? suffixes : DEFAULT_ALLOWED_HOST_SUFFIXES };
}

function isAllowedImageHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const { hosts, suffixes } = allowedImageHosts;

  if (hosts.has(host)) return true;
  return suffixes.some((suffix) => host.endsWith(suffix));
}

const allowedImageHosts = getAllowedImageHosts();

export async function GET(request: NextRequest) {
  const rawUrl = request.nextUrl.searchParams.get('url');

  if (!rawUrl) {
    return NextResponse.json({ error: 'URL parameter required' }, { status: 400 });
  }

  try {
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(rawUrl);
    } catch {
      return NextResponse.json({ error: 'Invalid URL' }, { status: 400 });
    }

    if (parsedUrl.protocol !== 'https:') {
      return NextResponse.json({ error: 'Only https URLs are allowed' }, { status: 400 });
    }

    if (parsedUrl.username || parsedUrl.password) {
      return NextResponse.json({ error: 'Credentials in URL are not allowed' }, { status: 400 });
    }

    if (parsedUrl.port && parsedUrl.port !== '443') {
      return NextResponse.json({ error: 'Only default https port is allowed' }, { status: 400 });
    }

    if (isPrivateOrLocalhost(parsedUrl.hostname) || !isAllowedImageHost(parsedUrl.hostname)) {
      return NextResponse.json({ error: 'Host not allowed' }, { status: 403 });
    }

    const response = await fetch(parsedUrl.toString(), {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      },
    });

    const finalUrl = new URL(response.url);
    if (isPrivateOrLocalhost(finalUrl.hostname) || !isAllowedImageHost(finalUrl.hostname)) {
      return NextResponse.json({ error: 'Redirected to disallowed host' }, { status: 403 });
    }

    if (!response.ok) {
      return NextResponse.json({ error: 'Failed to fetch image' }, { status: response.status });
    }

    const contentLengthHeader = response.headers.get('content-length');
    if (contentLengthHeader) {
      const size = Number(contentLengthHeader);
      if (Number.isFinite(size) && size > MAX_IMAGE_BYTES) {
        return NextResponse.json({ error: 'Image too large' }, { status: 413 });
      }
    }

    const imageBuffer = await response.arrayBuffer();
    if (imageBuffer.byteLength > MAX_IMAGE_BYTES) {
      return NextResponse.json({ error: 'Image too large' }, { status: 413 });
    }

    const contentType = response.headers.get('content-type') || 'image/jpeg';
    if (!contentType.toLowerCase().startsWith('image/')) {
      return NextResponse.json({ error: 'URL did not return an image' }, { status: 415 });
    }

    return new NextResponse(imageBuffer, {
      headers: {
        'Content-Type': contentType,
        'Cache-Control': 'public, max-age=86400', // Cache for 24 hours
      },
    });
  } catch (error) {
    console.error('Image proxy error:', error);
    return NextResponse.json({ error: 'Failed to proxy image' }, { status: 500 });
  }
}
