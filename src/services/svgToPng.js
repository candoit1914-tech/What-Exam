const { Resvg } = require('@resvg/resvg-js');

/**
 * Convert an SVG string to a PNG buffer.
 * @param {string} svgString - The SVG content to render
 * @param {object} opts - Options
 * @param {number} opts.width - Output width in pixels (default: 800)
 * @returns {Buffer} PNG image buffer
 */
async function svgToPng(svgString, opts = {}) {
  const width = opts.width || 800;

  const resvg = new Resvg(svgString, {
    fitTo: { mode: 'width', value: width },
    font: {
      loadSystemFonts: true,
      defaultFontFamily: 'Arial, Helvetica, sans-serif',
    },
    background: 'white',
  });

  const pngData = resvg.render();
  return Buffer.from(pngData.asPng());
}

module.exports = { svgToPng };
