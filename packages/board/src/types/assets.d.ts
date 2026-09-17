/**
 * Vite asset-URL imports. The board loads the Caveat WOFF (for opentype.js
 * glyph outlines) through `?url` so the bundler fingerprints and serves it;
 * we declare the module shape ourselves instead of depending on `vite/client`
 * so the package typechecks in any consumer.
 */
declare module '*.woff?url' {
  const url: string;
  export default url;
}
declare module '*.woff2?url' {
  const url: string;
  export default url;
}
declare module '*.ttf?url' {
  const url: string;
  export default url;
}
