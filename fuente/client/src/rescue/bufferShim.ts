/**
 * El kit de Fluidkey usa `Buffer` al derivar: en la app lo pone `main.tsx`;
 * en la página autónoma, este fichero (lo inyecta `scripts/build-rescue.ts`).
 */
import { Buffer } from "buffer";

const g = globalThis as unknown as { Buffer?: typeof Buffer };
g.Buffer = g.Buffer ?? Buffer;
