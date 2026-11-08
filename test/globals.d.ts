// Workers-only Web Crypto extension (bun-types lacks it). src/ no longer calls it; db.integration.test.ts still polyfills it.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
