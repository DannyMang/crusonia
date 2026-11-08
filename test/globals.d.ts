// Workers-only Web Crypto extension used by src/auth.ts. bun-types lacks it; tests never call it.
interface SubtleCrypto {
  timingSafeEqual(a: ArrayBuffer | ArrayBufferView, b: ArrayBuffer | ArrayBufferView): boolean;
}
