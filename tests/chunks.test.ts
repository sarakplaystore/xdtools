import { describe, expect, test } from 'vitest';
import { isMissingAssetError } from '../src/app/chunks';

/**
 * The detector decides whether a failed open means "a newer deployment replaced this tab's files"
 * (reload) or "this PDF cannot be read" (say so). Getting it wrong reloads a working tab, so both
 * directions matter.
 */
describe('isMissingAssetError', () => {
  test('pdf.js names the file it could not load', () => {
    expect(isMissingAssetError(new Error('Unable to load CMap data at: https://x.test/pdfjs/cmaps/Adobe-Japan1-0.bcmap'))).toBe(true);
    expect(isMissingAssetError(new Error('Unable to load standard font data at: /pdfjs/standard_fonts/FoxitSerif.pfb'))).toBe(true);
  });

  test('a lazy page that no longer exists is named by the browser', () => {
    expect(
      isMissingAssetError(new Error('error loading dynamically imported module: https://x.test/assets/PdfEditorPage-CKi7Y0W3.js')),
    ).toBe(true);
  });

  test('a request that got nothing at all', () => {
    expect(isMissingAssetError(new TypeError('Failed to fetch'))).toBe(true);
  });

  test('the cause chain is followed', () => {
    const inner = new Error('Unable to load CMap data at: /pdfjs/cmaps/x.bcmap');
    expect(isMissingAssetError(new Error('Loading failed', { cause: inner }))).toBe(true);
  });

  test('a damaged PDF is not mistaken for a missing file', () => {
    expect(isMissingAssetError(new Error('Invalid PDF structure'))).toBe(false);
    expect(isMissingAssetError(new Error('The file is damaged and could not be repaired'))).toBe(false);
    expect(isMissingAssetError(new Error('No password given'))).toBe(false);
    expect(isMissingAssetError(undefined)).toBe(false);
    // A page of text that happens to contain a path is not evidence either.
    expect(isMissingAssetError(new Error('Unexpected token in content stream /fonts/abc'))).toBe(false);
    expect(isMissingAssetError(new Error('Unexpected token in content stream /assets/x'))).toBe(false);
  });
});
