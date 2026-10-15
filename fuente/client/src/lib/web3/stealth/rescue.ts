/**
 * Rescate de las direcciones de depósito CON LA FRASE DE RECUPERACIÓN (Fase C,
 * paso C3; `docs/FASE-C-PASSKEY-OBLIGATORIA.md` §6).
 *
 * Para qué: en los modos «Solo tu llave» y «Tu llave y el código del correo»,
 * quien pierde todas sus llaves ya no puede firmar en Mucho. Lo que cuelga de
 * las rutas estándar de su frase lo recupera importándola en cualquier
 * billetera, pero las DIRECCIONES DE DEPÓSITO no: sus claves salen de una
 * firma de la cuenta sobre un mensaje fijo (`buildStealthKeygenMessage`) y
 * ninguna billetera corriente la hace. Aquí se hace esa firma EN EL NAVEGADOR
 * con la clave que da la frase, sin Turnkey, y de ahí sale todo lo demás con
 * la misma derivación de siempre (`derive.ts`).
 *
 * Por qué funciona: Turnkey firma de forma determinista (si no, la capa no se
 * podría re-derivar en cada sesión, y se re-deriva). De la firma solo se usan
 * `r` y `s` (`generateKeysFromSignature`), así que la `v` no importa; lo único
 * que podría diferir de una firma local es la forma de `s` (la «baja» que da
 * viem frente a la «alta»), y por eso se prueban LAS DOS (`signatureVariants`).
 * Cuál es la buena lo decide la meta-dirección registrada en el servidor
 * (`pickMasterKeys`): si ninguna coincide, se dice, no se gasta nada.
 *
 * Nada de lo que sale de aquí viaja al servidor: la frase, la clave de la
 * cuenta, la firma y las claves de la capa viven en memoria de la pestaña.
 */
import { mnemonicToAccount } from "viem/accounts";
import type { Address, Hex } from "viem";
import { validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import {
  buildStealthKeygenMessage,
  deriveMasterKeysFromSignature,
  type StealthMasterKeys,
} from "./derive";

/** Orden de la curva secp256k1 (para la `s` alternativa). */
const SECP256K1_N = BigInt(
  "0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141",
);

/** Espacios de cualquier tipo, mayúsculas y saltos de línea fuera. */
export function normalizeMnemonic(raw: string): string {
  return raw.trim().toLowerCase().split(/\s+/).filter(Boolean).join(" ");
}

export type MnemonicCheck =
  | { ok: true; mnemonic: string }
  | { ok: false; reason: string };

/** ¿Es una frase BIP-39 en inglés válida (12, 15, 18, 21 o 24 palabras)? */
export function checkMnemonic(raw: string): MnemonicCheck {
  const mnemonic = normalizeMnemonic(raw);
  const words = mnemonic ? mnemonic.split(" ") : [];
  if (![12, 15, 18, 21, 24].includes(words.length)) {
    return {
      ok: false,
      reason: `Una frase de recuperación tiene 12 o 24 palabras; aquí hay ${words.length}.`,
    };
  }
  const unknown = words.filter((w) => !wordlist.includes(w));
  if (unknown.length) {
    return {
      ok: false,
      reason: `${unknown.length === 1 ? "Esta palabra no está" : "Estas palabras no están"} en la lista: ${unknown.join(", ")}.`,
    };
  }
  if (!validateMnemonic(mnemonic, wordlist)) {
    return {
      ok: false,
      reason: "Las palabras existen, pero no forman una frase válida: revisa el orden y que no falte ni sobre ninguna.",
    };
  }
  return { ok: true, mnemonic };
}

/**
 * La cuenta `i` del monedero (Cuenta 1 = índice 0), en la ruta de siempre
 * `m/44'/60'/0'/0/i` (esquema MetaMask, la misma que usa Mucho).
 */
export function seedEvmAccount(mnemonic: string, index: number) {
  return mnemonicToAccount(mnemonic, { addressIndex: index });
}

/**
 * La firma con la `s` en sus dos formas (la que se recibe y `n − s`, con la
 * `v` cambiada para que siga siendo una firma válida del mismo mensaje).
 */
export function signatureVariants(signature: Hex): Hex[] {
  const hex = signature.slice(2);
  if (hex.length !== 130) return [signature];
  const r = hex.slice(0, 64);
  const s = BigInt(`0x${hex.slice(64, 128)}`);
  const v = parseInt(hex.slice(128, 130), 16);
  const flippedS = (SECP256K1_N - s).toString(16).padStart(64, "0");
  const flippedV = v === 27 ? 28 : v === 28 ? 27 : v === 0 ? 1 : 0;
  const other = `0x${r}${flippedS}${flippedV.toString(16).padStart(2, "0")}` as Hex;
  return [signature, other];
}

/** Las claves de la capa para cada forma de la firma. */
export function masterKeyCandidates(signature: Hex): StealthMasterKeys[] {
  return signatureVariants(signature).map(deriveMasterKeysFromSignature);
}

export type MasterPick =
  | { status: "match"; keys: StealthMasterKeys; variant: number }
  | { status: "mismatch"; registered: string }
  /** El servidor no tiene meta-dirección para esta cuenta (nunca se activó). */
  | { status: "unregistered" };

/**
 * Elige las claves cuya meta-dirección es la registrada. Sin registro no se
 * puede afirmar cuál es: el llamante decide (las direcciones se buscan con las
 * dos y se gasta solo de donde haya dinero).
 */
export function pickMasterKeys(
  candidates: StealthMasterKeys[],
  registeredMeta: string | null | undefined,
): MasterPick {
  if (!registeredMeta) return { status: "unregistered" };
  const want = registeredMeta.trim().toLowerCase();
  const i = candidates.findIndex((c) => c.metaAddress.toLowerCase() === want);
  return i >= 0
    ? { status: "match", keys: candidates[i]!, variant: i }
    : { status: "mismatch", registered: registeredMeta };
}

/**
 * Firma el mensaje de la capa con la cuenta `index` de la frase y devuelve las
 * claves candidatas. Es lo único que hace falta de la frase: después se olvida.
 */
export async function rescueCandidates(
  mnemonic: string,
  index: number,
): Promise<{ address: Address; candidates: StealthMasterKeys[] }> {
  const account = seedEvmAccount(mnemonic, index);
  const message = buildStealthKeygenMessage({ address: account.address });
  const signature = await account.signMessage({ message });
  return { address: account.address, candidates: masterKeyCandidates(signature) };
}

/** Una cosa que mover: un activo de UNA dirección de depósito en UNA red. */
export interface RescueItem {
  nonce: number;
  safe: Address;
  chainKey: string;
  symbol: string;
  /** Contrato; `null` = moneda nativa. */
  token: Address | null;
  decimals: number;
  /** Saldo en unidades mínimas. */
  balance: bigint;
  /** Lo que se envía (nativo: el saldo menos la reserva de gas). */
  amount: bigint;
}

/**
 * Orden de ejecución: por dirección, primero los tokens (el gas lo paga la
 * política) y después la moneda nativa (paga su propio gas, así que va la
 * última para no quedarse sin él a mitad). Lo que no cubre ni el gas se queda.
 */
export function orderRescueItems(items: RescueItem[]): RescueItem[] {
  return items
    .filter((i) => i.amount > 0n)
    .sort(
      (a, b) =>
        a.nonce - b.nonce ||
        a.chainKey.localeCompare(b.chainKey) ||
        Number(a.token === null) - Number(b.token === null),
    );
}
