/**
 * Image Analyzer Tool
 * Analyzes images in HTML for performance issues:
 * - Missing dimensions (causes CLS)
 * - Missing lazy loading
 * - Unoptimized formats (could be WebP/AVIF)
 * - Missing responsive images (srcset)
 * - Large images above the fold
 */

export interface ImageInfo {
  src: string;
  width?: number;
  height?: number;
  alt?: string;
  loading?: 'lazy' | 'eager' | 'auto';
  decoding?: 'async' | 'sync' | 'auto';
  fetchpriority?: 'high' | 'low' | 'auto';
  srcset?: string;
  sizes?: string;
  isAboveTheFold: boolean;
  issues: ImageIssue[];
}

export interface ImageIssue {
  type: 'missing-dimensions' | 'missing-lazy-load' | 'missing-srcset' | 'legacy-format' | 'missing-alt' | 'eager-offscreen' | 'no-fetchpriority-lcp';
  severity: 'high' | 'medium' | 'low';
  message: string;
}

export interface ImageAnalysisResult {
  url: string;
  totalImages: number;
  imagesWithIssues: number;
  images: ImageInfo[];
  summary: {
    missingDimensions: number;
    missingLazyLoad: number;
    missingSrcset: number;
    legacyFormats: number;
    missingAlt: number;
  };
  recommendations: string[];
  error?: string;
}

// Image formats that could be optimized to WebP/AVIF
const LEGACY_FORMATS = ['.jpg', '.jpeg', '.png', '.gif', '.bmp'];
const MODERN_FORMATS = ['.webp', '.avif', '.svg'];

// Patterns that indicate an image is likely above the fold
const ABOVE_FOLD_PATTERNS = [
  /hero/i,
  /banner/i,
  /header/i,
  /logo/i,
  /featured/i,
  /slider/i,
  /carousel/i,
  /masthead/i,
];

// Parse an img tag and extract attributes
function parseImgTag(imgTag: string): Partial<ImageInfo> {
  const info: Partial<ImageInfo> = {};

  // Extract src
  const srcMatch = imgTag.match(/\bsrc=["']([^"']+)["']/i);
  if (srcMatch) {
    info.src = srcMatch[1];
  }

  // Extract data-src (lazy loaded images)
  if (!info.src) {
    const dataSrcMatch = imgTag.match(/\bdata-src=["']([^"']+)["']/i);
    if (dataSrcMatch) {
      info.src = dataSrcMatch[1];
    }
  }

  // Extract width
  const widthMatch = imgTag.match(/\bwidth=["']?(\d+)["']?/i);
  if (widthMatch) {
    info.width = parseInt(widthMatch[1], 10);
  }

  // Extract height
  const heightMatch = imgTag.match(/\bheight=["']?(\d+)["']?/i);
  if (heightMatch) {
    info.height = parseInt(heightMatch[1], 10);
  }

  // Extract alt
  const altMatch = imgTag.match(/\balt=["']([^"']*)["']/i);
  if (altMatch) {
    info.alt = altMatch[1];
  }

  // Extract loading attribute
  const loadingMatch = imgTag.match(/\bloading=["']?(lazy|eager|auto)["']?/i);
  if (loadingMatch) {
    info.loading = loadingMatch[1].toLowerCase() as 'lazy' | 'eager' | 'auto';
  }

  // Extract decoding attribute
  const decodingMatch = imgTag.match(/\bdecoding=["']?(async|sync|auto)["']?/i);
  if (decodingMatch) {
    info.decoding = decodingMatch[1].toLowerCase() as 'async' | 'sync' | 'auto';
  }

  // Extract fetchpriority
  const fetchpriorityMatch = imgTag.match(/\bfetchpriority=["']?(high|low|auto)["']?/i);
  if (fetchpriorityMatch) {
    info.fetchpriority = fetchpriorityMatch[1].toLowerCase() as 'high' | 'low' | 'auto';
  }

  // Extract srcset
  const srcsetMatch = imgTag.match(/\bsrcset=["']([^"']+)["']/i);
  if (srcsetMatch) {
    info.srcset = srcsetMatch[1];
  }

  // Extract sizes
  const sizesMatch = imgTag.match(/\bsizes=["']([^"']+)["']/i);
  if (sizesMatch) {
    info.sizes = sizesMatch[1];
  }

  return info;
}

// Check if image URL suggests it's a legacy format
function isLegacyFormat(src: string): boolean {
  const lowerSrc = src.toLowerCase();
  // Skip data URIs and SVGs
  if (lowerSrc.startsWith('data:') || lowerSrc.includes('.svg')) {
    return false;
  }
  return LEGACY_FORMATS.some(ext => lowerSrc.includes(ext));
}

// Check if image is likely above the fold based on context
function isLikelyAboveFold(imgTag: string, position: number, totalLength: number): boolean {
  // If in first 20% of HTML, likely above fold
  if (position < totalLength * 0.2) {
    return true;
  }

  // Check for above-fold class/ID patterns
  if (ABOVE_FOLD_PATTERNS.some(pattern => pattern.test(imgTag))) {
    return true;
  }

  // Check for fetchpriority="high" which indicates LCP candidate
  if (/fetchpriority=["']?high/i.test(imgTag)) {
    return true;
  }

  return false;
}

// Analyze a single image and generate issues
function analyzeImage(imgTag: string, position: number, totalLength: number): ImageInfo {
  const parsed = parseImgTag(imgTag);
  const issues: ImageIssue[] = [];

  // Skip if no src found
  if (!parsed.src) {
    return {
      src: '',
      isAboveTheFold: false,
      issues: [],
    };
  }

  const isAboveTheFold = isLikelyAboveFold(imgTag, position, totalLength);

  // Check for missing dimensions (causes CLS)
  if (!parsed.width || !parsed.height) {
    issues.push({
      type: 'missing-dimensions',
      severity: 'high',
      message: 'Missing width/height attributes causes Cumulative Layout Shift (CLS)',
    });
  }

  // Check for missing lazy loading on below-fold images
  if (!isAboveTheFold && parsed.loading !== 'lazy') {
    // Check if it has data-src pattern (custom lazy loading)
    const hasCustomLazy = /data-src|data-lazy|lazyload/i.test(imgTag);
    if (!hasCustomLazy) {
      issues.push({
        type: 'missing-lazy-load',
        severity: 'medium',
        message: 'Below-fold image should use loading="lazy" for better performance',
      });
    }
  }

  // Check for eager loading on above-fold images without fetchpriority
  if (isAboveTheFold && !parsed.fetchpriority) {
    issues.push({
      type: 'no-fetchpriority-lcp',
      severity: 'low',
      message: 'Above-fold image (potential LCP) should use fetchpriority="high"',
    });
  }

  // Check for legacy formats
  if (isLegacyFormat(parsed.src)) {
    issues.push({
      type: 'legacy-format',
      severity: 'medium',
      message: 'Image uses legacy format (JPG/PNG/GIF) - consider WebP or AVIF',
    });
  }

  // Check for missing srcset on larger images
  if (!parsed.srcset && parsed.width && parsed.width > 300) {
    issues.push({
      type: 'missing-srcset',
      severity: 'medium',
      message: 'Large image without srcset - consider responsive images for different screen sizes',
    });
  }

  // Check for missing alt text (accessibility + SEO)
  if (parsed.alt === undefined || parsed.alt === '') {
    // Skip decorative images or icons
    const isDecorative = /icon|spacer|pixel|blank|transparent/i.test(parsed.src);
    if (!isDecorative) {
      issues.push({
        type: 'missing-alt',
        severity: 'low',
        message: 'Missing alt text affects accessibility and SEO',
      });
    }
  }

  return {
    src: parsed.src,
    width: parsed.width,
    height: parsed.height,
    alt: parsed.alt,
    loading: parsed.loading,
    decoding: parsed.decoding,
    fetchpriority: parsed.fetchpriority,
    srcset: parsed.srcset,
    sizes: parsed.sizes,
    isAboveTheFold,
    issues,
  };
}

export interface ImageAnalyzerOptions {
  maxImages?: number; // Limit number of images to analyze (default: 50)
}

export function analyzeImages(
  html: string,
  url: string,
  options: ImageAnalyzerOptions = {}
): ImageAnalysisResult {
  const { maxImages = 50 } = options;

  const result: ImageAnalysisResult = {
    url,
    totalImages: 0,
    imagesWithIssues: 0,
    images: [],
    summary: {
      missingDimensions: 0,
      missingLazyLoad: 0,
      missingSrcset: 0,
      legacyFormats: 0,
      missingAlt: 0,
    },
    recommendations: [],
  };

  // Find all img tags
  const imgRegex = /<img[^>]+>/gi;
  const matches = html.matchAll(imgRegex);
  const totalLength = html.length;

  for (const match of matches) {
    if (result.totalImages >= maxImages) {
      break;
    }

    const imgTag = match[0];
    const position = match.index || 0;

    const imageInfo = analyzeImage(imgTag, position, totalLength);

    // Skip images without src
    if (!imageInfo.src) {
      continue;
    }

    result.totalImages++;
    result.images.push(imageInfo);

    if (imageInfo.issues.length > 0) {
      result.imagesWithIssues++;

      // Update summary counts
      for (const issue of imageInfo.issues) {
        switch (issue.type) {
          case 'missing-dimensions':
            result.summary.missingDimensions++;
            break;
          case 'missing-lazy-load':
            result.summary.missingLazyLoad++;
            break;
          case 'missing-srcset':
            result.summary.missingSrcset++;
            break;
          case 'legacy-format':
            result.summary.legacyFormats++;
            break;
          case 'missing-alt':
            result.summary.missingAlt++;
            break;
        }
      }
    }
  }

  // Generate recommendations based on findings
  if (result.summary.missingDimensions > 0) {
    result.recommendations.push(
      `Add width and height attributes to ${result.summary.missingDimensions} image(s) to prevent layout shifts (CLS)`
    );
  }

  if (result.summary.missingLazyLoad > 0) {
    result.recommendations.push(
      `Add loading="lazy" to ${result.summary.missingLazyLoad} below-fold image(s) to improve initial page load`
    );
  }

  if (result.summary.legacyFormats > 0) {
    result.recommendations.push(
      `Convert ${result.summary.legacyFormats} image(s) from JPG/PNG to WebP/AVIF for 25-50% size reduction`
    );
  }

  if (result.summary.missingSrcset > 0) {
    result.recommendations.push(
      `Add srcset to ${result.summary.missingSrcset} large image(s) to serve appropriately sized images on different devices`
    );
  }

  // Check for LCP candidates without fetchpriority
  const lcpCandidates = result.images.filter(
    img => img.isAboveTheFold && img.issues.some(i => i.type === 'no-fetchpriority-lcp')
  );
  if (lcpCandidates.length > 0) {
    result.recommendations.push(
      `Add fetchpriority="high" to ${lcpCandidates.length} above-fold image(s) to improve Largest Contentful Paint (LCP)`
    );
  }

  return result;
}

// MCP Tool definition
export const imageAnalyzerTool = {
  name: 'image-analyzer',
  description: 'Analyzes images in HTML for performance issues: missing dimensions, lazy loading, srcset, format optimization',
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'The URL being analyzed (for reporting)',
      },
      html: {
        type: 'string',
        description: 'The HTML content to analyze',
      },
      maxImages: {
        type: 'number',
        description: 'Maximum number of images to analyze (default: 50)',
      },
    },
    required: ['url', 'html'],
  },
};
