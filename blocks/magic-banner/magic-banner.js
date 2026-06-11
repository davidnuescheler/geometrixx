/**
 * Magic Banner Block
 * Fetches a referenced SVG and replaces the block with it in the DOM.
 * SVG text nodes tagged with (selector) are filled entirely from block content.
 * Elements tagged mb-img-N with a url() fill use the Nth block image as fill.
 */

const PLACEHOLDER_PATTERN = /\(([^)]+)\)/;
const FILL_URL_PATTERN = /url\(/i;
const SVG_NS = 'http://www.w3.org/2000/svg';
const IMAGE_SLOT_PATTERN = /^mb-img-(\d+)$/;

/**
 * Loads an SVG from a same-origin path.
 * @param {string} path Path to the SVG asset
 * @returns {Promise<SVGSVGElement|null>} Parsed SVG element or null
 */
async function loadSvg(path) {
  if (path && path.startsWith('/') && !path.startsWith('//')) {
    const resp = await fetch(path);
    if (resp.ok) {
      const text = await resp.text();
      const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
      const svg = doc.querySelector('svg');
      if (svg) return svg;
    }
  }
  return null;
}

/**
 * Resolves block text for a placeholder selector.
 * Uses the innermost match so wrapper paragraphs created by wrapTextNodes
 * (when a picture is the first column child) are not returned.
 * @param {Element} block The block element
 * @param {string} selector CSS selector from an SVG placeholder
 * @returns {string|null} Matching element text content
 */
function getBlockText(block, selector) {
  const matches = [...block.querySelectorAll(selector.trim())]
    .filter((el) => !el.matches('a[href$=".svg"]'));
  if (!matches.length) return null;

  const source = matches.find(
    (el) => !matches.some((other) => other !== el && el.contains(other)),
  ) || matches[matches.length - 1];

  return source.textContent?.trim() ?? '';
}

/**
 * Builds a document-unique prefix for defs ids inside an SVG template.
 * @param {SVGSVGElement} svg The SVG root element
 * @returns {string}
 */
function getTemplatePrefix(svg) {
  const label = svg.getAttribute('aria-label') || 'banner';
  return label.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-');
}

/**
 * Returns authored image URLs from the block in document order.
 * @param {Element} block The block element
 * @returns {string[]}
 */
function getBlockImages(block) {
  return [...block.querySelectorAll('picture img, img')]
    .map((img) => img.currentSrc || img.getAttribute('src'))
    .filter(Boolean);
}

/**
 * Reads an mb-img-N slot index from an element id or class.
 * @param {Element} element SVG element
 * @returns {number|null} 1-based slot index
 */
function getImageSlotIndex(element) {
  const idMatch = element.id?.match(IMAGE_SLOT_PATTERN);
  if (idMatch) return parseInt(idMatch[1], 10);

  const className = [...element.classList].find((name) => IMAGE_SLOT_PATTERN.test(name));
  if (className) return parseInt(className.replace('mb-img-', ''), 10);

  return null;
}

/**
 * Creates or updates a pattern used to fill a slot with a raster image.
 * @param {SVGSVGElement} svg The SVG root element
 * @param {string} patternId Pattern id
 * @param {string} src Image URL
 * @param {string} width Pattern width
 * @param {string} height Pattern height
 */
function ensureImagePattern(svg, patternId, src, width, height) {
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS(SVG_NS, 'defs');
    svg.prepend(defs);
  }

  let pattern = defs.querySelector(`#${patternId}`);
  if (!pattern) {
    pattern = document.createElementNS(SVG_NS, 'pattern');
    pattern.setAttribute('id', patternId);
    pattern.setAttribute('patternUnits', 'userSpaceOnUse');
    const image = document.createElementNS(SVG_NS, 'image');
    image.setAttribute('preserveAspectRatio', 'xMidYMid slice');
    pattern.append(image);
    defs.append(pattern);
  }

  pattern.setAttribute('x', '0');
  pattern.setAttribute('y', '0');
  pattern.setAttribute('width', width);
  pattern.setAttribute('height', height);

  const image = pattern.querySelector('image');
  image.setAttribute('href', src);
  image.setAttribute('x', '0');
  image.setAttribute('y', '0');
  image.setAttribute('width', width);
  image.setAttribute('height', height);
}

/**
 * Replaces url() fills on mb-img-N slots with block images.
 * @param {SVGSVGElement} svg The SVG root element
 * @param {string[]} images Image URLs in block order
 * @param {Element} [scope] Optional layout group to limit updates
 */
function applyImageFills(svg, images, scope = svg) {
  const templatePrefix = getTemplatePrefix(svg);

  scope.querySelectorAll('[id^="mb-img-"], [class*="mb-img-"]').forEach((element) => {
    const index = getImageSlotIndex(element);
    if (!index) return;

    const src = images[index - 1];
    if (!src) return;

    const fill = element.getAttribute('fill');
    if (!fill || !FILL_URL_PATTERN.test(fill)) return;

    const width = element.getAttribute('width');
    const height = element.getAttribute('height');
    if (!width || !height) return;

    const patternId = `${templatePrefix}-img-${index}-fill`;
    ensureImagePattern(svg, patternId, src, width, height);
    element.setAttribute('fill', `url(#${patternId})`);
  });
}

/**
 * Replaces tagged SVG text nodes entirely with matching block content.
 * @param {Element} block The block element
 * @param {SVGElement} svg The SVG root element
 */
function applySvgPlaceholders(block, svg) {
  svg.querySelectorAll('text, tspan').forEach((node) => {
    if (node.querySelector('tspan')) return;

    const match = node.textContent?.match(PLACEHOLDER_PATTERN);
    if (!match) return;

    const value = getBlockText(block, match[1]);
    if (value !== null) node.textContent = value;
  });
}

/**
 * Reads responsive layout groups declared in the SVG template.
 * Layout groups use data-media and data-view-box on the same element.
 * @param {SVGSVGElement} svg The SVG root element
 * @returns {Array<{element: Element, query: string, viewBox: string}>}
 */
function getResponsiveLayouts(svg) {
  return [...svg.querySelectorAll('[data-media][data-view-box]')].map((element) => ({
    element,
    query: element.getAttribute('data-media'),
    viewBox: element.getAttribute('data-view-box'),
  }));
}

/**
 * Applies the active layout and viewBox based on SVG-declared media queries.
 * @param {SVGSVGElement} svg The SVG root element
 * @param {string[]} images Image URLs for mb-img-N slots
 */
function setupResponsiveSvg(svg, images = []) {
  const layouts = getResponsiveLayouts(svg);
  if (!layouts.length) return;

  const queries = layouts.map((layout) => ({
    ...layout,
    mql: window.matchMedia(layout.query),
  }));

  const apply = () => {
    const active = [...queries].reverse().find((layout) => layout.mql.matches) || queries[0];
    layouts.forEach(({ element }) => element.classList.add('magic-banner-layout-hidden'));
    active.element.classList.remove('magic-banner-layout-hidden');
    svg.setAttribute('viewBox', active.viewBox);
    if (images.length) applyImageFills(svg, images, active.element);
  };

  apply();
  queries.forEach(({ mql }) => mql.addEventListener('change', apply));
}

/**
 * Loads and decorates the magic-banner block.
 * @param {Element} block The block element
 */
export default async function decorate(block) {
  const link = block.querySelector('a[href$=".svg"]');
  const path = link ? link.getAttribute('href') : block.textContent.trim();
  const label = link?.textContent?.trim();

  const svg = await loadSvg(path);
  if (!svg) return;

  applySvgPlaceholders(block, svg);

  const images = getBlockImages(block);
  const banner = document.importNode(svg, true);
  banner.classList.add('magic-banner');

  if (label && !banner.getAttribute('aria-label') && !banner.querySelector('title')) {
    banner.setAttribute('role', 'img');
    banner.setAttribute('aria-label', label);
  }

  setupResponsiveSvg(banner, images);
  block.replaceWith(banner);
}
