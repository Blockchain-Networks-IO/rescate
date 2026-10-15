/**
 * Derivación de direcciones stealth (modelo Fluidkey / ERC-5564).
 *
 * TODA esta lógica corre EN CLIENTE: produce claves privadas (spending/viewing
 * y la clave de cada dirección stealth) que NUNCA deben viajar al servidor
 * (mismo principio que el xpub en `docs/portfolio-xpub-privacidad.md`). El
 * servidor solo recibe datos PÚBLICOS (la meta-dirección).
 *
 * Flujo (ver `docs/WALLET-PRIVACY-SPEC.md` §5):
 *   1. El usuario firma un mensaje fijo con Turnkey (`signMessageEip191`).
 *   2. De esa firma se derivan, de forma DETERMINISTA, la `spendingPrivateKey`
 *      y la `viewingPrivateKey` (re-derivables → recuperación independiente).
 *   3. Por cada `nonce` se deriva una dirección stealth (EOA) y la clave que la
 *      controla, además de la `ephemeralPublicKey` a anunciar (ERC-5564).
 *
 * La clave de cada stealth (`stealthPrivateKey`) controla directamente el EOA
 * `address` (verificado: `privateKeyToAccount(stealthPrivateKey).address ===
 * address`). El MVP recibe en ese EOA y barre al wallet Turnkey; el Safe/4337
 * (opción B del spec) se añade después y no se cubre aquí.
 */
import { privateKeyToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import {
  generateFluidkeyMessage,
  generateKeysFromSignature,
  extractViewingPrivateKeyNode,
  generateEphemeralPrivateKey,
  generateStealthAddresses,
  generateStealthPrivateKey,
} from "@fluidkey/stealth-account-kit";

/** Esquema ERC-5564 secp256k1 (el único definido hoy). */
export const STEALTH_SCHEME_ID = 1 as const;

/** Claves maestras del usuario, derivadas de una sola firma. Privadas: cliente. */
export interface StealthMasterKeys {
  spendingPrivateKey: Hex;
  viewingPrivateKey: Hex;
  /** Pública (sin comprimir, 0x04…) — para derivar direcciones. */
  spendingPublicKey: Hex;
  /** Pública (sin comprimir, 0x04…). */
  viewingPublicKey: Hex;
  /** Meta-dirección ERC-6538 `st:<shortName>:0x<spendComp><viewComp>` (PÚBLICA). */
  metaAddress: string;
}

/** Una dirección stealth concreta (para un `nonce`). */
export interface StealthAccount {
  nonce: bigint;
  /** Dirección stealth (EOA) donde se recibe. */
  address: Address;
  /** Clave privada que controla `address` (para barrer/gastar). NUNCA al server. */
  stealthPrivateKey: Hex;
  /** Clave efímera pública a publicar en el Announcement ERC-5564. */
  ephemeralPublicKey: Hex;
}

/**
 * Mensaje fijo que el usuario firma para sembrar sus claves stealth. El `pin`
 * es opcional (factor extra que permite varios juegos de claves por wallet); si
 * se omite, se usa cadena vacía → un único juego determinista por dirección.
 */
export function buildStealthKeygenMessage(params: {
  address: string;
  pin?: string;
}): string {
  const { message } = generateFluidkeyMessage({
    pin: params.pin ?? "",
    address: params.address,
  });
  return message;
}

/**
 * Comprime una clave pública secp256k1 sin comprimir (0x04 || X || Y, 65 bytes)
 * a su forma comprimida (0x02/0x03 || X, 33 bytes) según la paridad de Y. Evita
 * añadir una dependencia de curvas: la regla es estándar y simple.
 */
export function compressPublicKey(uncompressed: Hex): Hex {
  const hex = uncompressed.startsWith("0x") ? uncompressed.slice(2) : uncompressed;
  if (hex.length !== 130 || !hex.startsWith("04")) {
    throw new Error("[stealth] clave pública no es 0x04||X||Y (65 bytes)");
  }
  const x = hex.slice(2, 66);
  const y = hex.slice(66, 130);
  const yIsOdd = parseInt(y.slice(-1), 16) % 2 === 1;
  return `0x${yIsOdd ? "03" : "02"}${x}` as Hex;
}

/** Construye la meta-dirección ERC-6538 a partir de las claves públicas. */
export function buildMetaAddress(
  spendingPublicKey: Hex,
  viewingPublicKey: Hex,
  shortName = "eth"
): string {
  const spend = compressPublicKey(spendingPublicKey).slice(2);
  const view = compressPublicKey(viewingPublicKey).slice(2);
  return `st:${shortName}:0x${spend}${view}`;
}

/**
 * Deriva las claves maestras (spending/viewing) de la firma del mensaje fijo.
 * Determinista: la misma firma produce siempre las mismas claves.
 */
export function deriveMasterKeysFromSignature(signature: Hex): StealthMasterKeys {
  const { spendingPrivateKey, viewingPrivateKey } =
    generateKeysFromSignature(signature);
  const spendingPublicKey = privateKeyToAccount(spendingPrivateKey).publicKey;
  const viewingPublicKey = privateKeyToAccount(viewingPrivateKey).publicKey;
  return {
    spendingPrivateKey,
    viewingPrivateKey,
    spendingPublicKey,
    viewingPublicKey,
    metaAddress: buildMetaAddress(spendingPublicKey, viewingPublicKey),
  };
}

/**
 * Deriva la dirección stealth para un `nonce` dado. `chainId` por defecto 0
 * (direcciones agnósticas de cadena, como Fluidkey); pásalo para segregar por
 * red. `viewingNode` selecciona el nodo BIP-32 de la viewing key (0 por defecto).
 */
export function deriveStealthAccount(
  master: Pick<
    StealthMasterKeys,
    "spendingPrivateKey" | "viewingPrivateKey" | "spendingPublicKey"
  >,
  opts: { nonce: bigint; chainId?: number; viewingNode?: number }
): StealthAccount {
  const node = extractViewingPrivateKeyNode(
    master.viewingPrivateKey,
    opts.viewingNode ?? 0
  );
  const { ephemeralPrivateKey } = generateEphemeralPrivateKey({
    viewingPrivateKeyNode: node,
    nonce: opts.nonce,
    chainId: opts.chainId ?? 0,
  });
  const ephemeralPublicKey = privateKeyToAccount(ephemeralPrivateKey).publicKey;
  const { stealthAddresses } = generateStealthAddresses({
    spendingPublicKeys: [master.spendingPublicKey],
    ephemeralPrivateKey,
  });
  const { stealthPrivateKey } = generateStealthPrivateKey({
    spendingPrivateKey: master.spendingPrivateKey,
    ephemeralPublicKey,
  });
  return {
    nonce: opts.nonce,
    address: stealthAddresses[0] as Address,
    stealthPrivateKey,
    ephemeralPublicKey,
  };
}

/**
 * Enumera un rango de direcciones stealth `[startNonce, endNonce]`. Base de la
 * detección de cobros y de la prueba de propiedad (re-enumeración determinista).
 */
export function enumerateStealthAccounts(
  master: Pick<
    StealthMasterKeys,
    "spendingPrivateKey" | "viewingPrivateKey" | "spendingPublicKey"
  >,
  opts: {
    startNonce: bigint;
    endNonce: bigint;
    chainId?: number;
    viewingNode?: number;
  }
): StealthAccount[] {
  const out: StealthAccount[] = [];
  for (let nonce = opts.startNonce; nonce <= opts.endNonce; nonce++) {
    out.push(
      deriveStealthAccount(master, {
        nonce,
        chainId: opts.chainId,
        viewingNode: opts.viewingNode,
      })
    );
  }
  return out;
}

/** Material mínimo para DERIVAR direcciones sin poder gastar (solo lectura). */
export interface StealthViewMaterial {
  viewingPrivateKey: Hex;
  spendingPublicKey: Hex;
}

/**
 * Deriva SOLO la DIRECCIÓN stealth de un `nonce` a partir de la clave de visión y
 * la pública de gasto — sin la clave de gasto, así que NO puede gastar. Produce la
 * misma dirección que `deriveStealthAccount` (de ahí que valga para leer saldos y
 * para el modo "ver con PIN"). Ver `viewKey.ts`.
 */
export function deriveStealthAddressViewOnly(
  view: StealthViewMaterial,
  opts: { nonce: bigint; chainId?: number; viewingNode?: number }
): Address {
  const node = extractViewingPrivateKeyNode(
    view.viewingPrivateKey,
    opts.viewingNode ?? 0
  );
  const { ephemeralPrivateKey } = generateEphemeralPrivateKey({
    viewingPrivateKeyNode: node,
    nonce: opts.nonce,
    chainId: opts.chainId ?? 0,
  });
  const { stealthAddresses } = generateStealthAddresses({
    spendingPublicKeys: [view.spendingPublicKey],
    ephemeralPrivateKey,
  });
  return stealthAddresses[0] as Address;
}
