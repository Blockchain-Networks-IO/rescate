/**
 * Núcleo de la herramienta de rescate AUTÓNOMA de las direcciones de depósito
 * (`rescate.html`, `docs/RESCATE-DIRECCIONES-DE-DEPOSITO.md`).
 *
 * Para cuando Mucho no está: ni servidor, ni bundler, ni paymaster, ni
 * indexador. Todo sale de la firma de la cuenta ancla sobre el mensaje fijo
 * (la misma derivación del monedero, `stealth/derive.ts` + `stealth/rescue.ts`)
 * y de un RPC público que el usuario puede cambiar:
 *
 *  1. firma → claves de la capa (las dos formas de la `s`, como en C3);
 *  2. por cada nonce, su dueño y su Safe (`counterfactualSafeAddress`, el MISMO
 *     código que usa el monedero, sin red);
 *  3. saldos leídos en cadena: moneda nativa + tokens conocidos + los que pegue;
 *  4. sacar: si el Safe no está desplegado, la llamada a la factoría que lo
 *     despliega (`counterfactualSafeDeployment`); luego `execTransaction`
 *     firmado por el dueño del Safe. El gas lo paga OTRA cuenta (la billetera
 *     conectada o una clave), así que la moneda nativa sale ENTERA.
 *
 * Lo de este fichero no toca el DOM: lo usan `standalone.ts` y los tests.
 */
import {
  createPublicClient,
  encodeFunctionData,
  erc20Abi,
  fallback,
  hashTypedData,
  http,
  parseAbi,
  zeroAddress,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getChain, type ChainKey } from "@shared/wallet/chains";
import { knownTokens } from "@shared/wallet/knownTokens";
import { counterfactualSafeAddress, counterfactualSafeDeployment } from "@shared/wallet/safeAddress";
import { deriveStealthAccount, type StealthMasterKeys } from "@/lib/web3/stealth/derive";
import { fluidkeyDeployCall, fluidkeyProfile, fluidkeySafeAddress } from "./fluidkey";

/** Redes donde se buscan, en este orden. HyperEVM y Robinhood van aparte (sin indexador ni prisa). */
export const RESCUE_CHAINS: ChainKey[] = ["arbitrum", "base", "ethereum", "optimism", "polygon", "bnb", "hyperevm"];

export interface RescueNote {
  /** Juego de claves (0 = forma de la firma tal cual, 1 = la otra `s`). */
  keySet: number;
  nonce: number;
  owner: Address;
  ownerKey: Hex;
  safe: Address;
  /**
   * Solo en modo Fluidkey (`fluidkey.ts`): con qué configuración se calculó el
   * Safe (1.3.0, sin módulo 4337). Sin él es un Safe de Mucho.
   */
  fluidkeyProfile?: string;
}

/** Los Safes de los nonces `0..count-1` para cada juego de claves. Sin red. */
export async function rescueNotes(keySets: StealthMasterKeys[], count: number): Promise<RescueNote[]> {
  const out: RescueNote[] = [];
  for (let k = 0; k < keySets.length; k++) {
    for (let n = 0; n < count; n++) {
      const acc = deriveStealthAccount(keySets[k]!, { nonce: BigInt(n) });
      const safe = await counterfactualSafeAddress(acc.address);
      out.push({ keySet: k, nonce: n, owner: acc.address, ownerKey: acc.stealthPrivateKey, safe });
    }
  }
  return out;
}

export interface RescueAsset {
  chain: ChainKey;
  symbol: string;
  /** `null` = moneda nativa. */
  token: Address | null;
  decimals: number;
  /**
   * Participaciones de una bóveda ERC-4626 (el auto-earn de Fluidkey): se
   * sacan con `redeem`, que manda al destino el activo de debajo.
   */
  vault?: boolean;
}

/** Lo que se mira en cada red: nativo + tokens del catálogo + los añadidos a mano. */
export function assetsFor(chain: ChainKey, extra: RescueAsset[] = []): RescueAsset[] {
  const c = getChain(chain);
  const list: RescueAsset[] = [{ chain, symbol: c.nativeSymbol, token: null, decimals: c.nativeDecimals }];
  for (const t of knownTokens(chain)) {
    list.push({ chain, symbol: t.symbol, token: t.address as Address, decimals: t.decimals });
  }
  for (const e of extra) {
    if (e.chain === chain && e.token && !list.some((l) => l.token?.toLowerCase() === e.token!.toLowerCase())) {
      list.push(e);
    }
  }
  return list;
}

/** La red en la forma que piden los clientes de viem (con el RPC elegido). */
export function rescueChain(chain: ChainKey, rpcUrl?: string): Chain {
  const c = getChain(chain);
  if (c.kind !== "evm" || !c.evmChainId) throw new Error(`${c.name} no es una red EVM.`);
  const url = rpcUrl?.trim() || c.defaultRpcUrl;
  if (!url) throw new Error(`Sin RPC para ${c.name}: pon uno.`);
  return {
    id: c.evmChainId,
    name: c.name,
    nativeCurrency: { name: c.nativeSymbol, symbol: c.nativeSymbol, decimals: c.nativeDecimals },
    rpcUrls: { default: { http: [url] } },
    ...(c.explorer ? { blockExplorers: { default: { name: c.name, url: c.explorer } } } : {}),
    ...(c.multicall3 ? { contracts: { multicall3: { address: c.multicall3 as Address } } } : {}),
  };
}

/**
 * Un SEGUNDO RPC público por red (los que trae viem), para que una caída o un
 * límite de peticiones del primero no tumbe el rescate a medias (pasó en la
 * primera prueba real, 15-10-2026: «HTTP request failed» tras desplegar).
 */
const BACKUP_RPC: Partial<Record<ChainKey, string>> = {
  arbitrum: "https://arb1.arbitrum.io/rpc",
  base: "https://mainnet.base.org",
  ethereum: "https://eth.merkle.io",
  optimism: "https://mainnet.optimism.io",
  polygon: "https://polygon.drpc.org",
  bnb: "https://56.rpc.thirdweb.com",
  hyperevm: "https://rpc.hyperliquid.xyz/evm",
};

/**
 * Nodo del propio monedero (`<base>/api/rpc/<chainId>`, el mismo proxy que usa
 * la app: dRPC/Alchemy con nuestra clave, que nunca sale del servidor). Solo
 * existe cuando la página se abre desde nuestra web; abierta desde el disco o
 * desde GitHub Pages no hay a quién preguntar y se va directa a los públicos.
 */
let muchoRpcBase: string | null = null;
export function setMuchoRpcBase(base: string | null): void {
  muchoRpcBase = base;
}

/**
 * Los RPC que se usan, en orden. PURA (con `muchoBase` explícito):
 *  - si el usuario escribió uno, ese y el de respaldo (manda él);
 *  - si no, el nodo de Mucho cuando lo hay, el público por defecto y el de respaldo.
 */
export function rescueRpcUrls(chain: ChainKey, rpcUrl?: string, muchoBase: string | null = muchoRpcBase): string[] {
  const typed = rpcUrl?.trim();
  const first = rescueChain(chain, typed).rpcUrls.default.http[0]!;
  const backup = BACKUP_RPC[chain];
  const list: string[] = [];
  if (!typed && muchoBase) list.push(`${muchoBase}/api/rpc/${getChain(chain).evmChainId}`);
  list.push(first);
  if (backup && backup !== first) list.push(backup);
  return list;
}

export function rescueClient(chain: ChainKey, rpcUrl?: string): PublicClient {
  const viemChain = rescueChain(chain, rpcUrl);
  const urls = rescueRpcUrls(chain, rpcUrl);
  return createPublicClient({
    chain: viemChain,
    transport: fallback(urls.map((u) => http(u, { batch: { batchSize: 20 }, retryCount: 2 }))),
    batch: viemChain.contracts?.multicall3 ? { multicall: true } : undefined,
  }) as PublicClient;
}

export interface RescueHolding {
  note: RescueNote;
  asset: RescueAsset;
  balance: bigint;
}

/**
 * Saldos de las notas en una red. Una lectura que falla NO es un cero: se
 * devuelve aparte para decirlo.
 */
export async function readHoldings(
  client: PublicClient,
  notes: RescueNote[],
  assets: RescueAsset[],
  onProgress?: (done: number, total: number) => void,
): Promise<{ holdings: RescueHolding[]; failed: number }> {
  const holdings: RescueHolding[] = [];
  let failed = 0;
  const jobs = notes.flatMap((note) => assets.map((asset) => ({ note, asset })));
  const multicall3 = client.chain?.contracts?.multicall3?.address;
  if (multicall3) {
    // Con Multicall3, en tandas grandes: el modo Fluidkey mira cientos de Safes
    // por red (un Safe por nonce Y por configuración) y, una lectura por
    // llamada, un RPC público corta enseguida por límite de peticiones. El
    // nativo va con `getEthBalance` del propio Multicall3. Las tandas van de
    // `MULTICALL_PARALLEL` en `MULTICALL_PARALLEL`: una detrás de otra, 40
    // direcciones en Base eran ~30 peticiones seguidas y la página parecía
    // colgada (20-11-2026).
    const chunks: Array<typeof jobs> = [];
    for (let i = 0; i < jobs.length; i += MULTICALL_CHUNK) chunks.push(jobs.slice(i, i + MULTICALL_CHUNK));
    let done = 0;
    onProgress?.(0, chunks.length);
    const readChunk = async (slice: typeof jobs) => {
      let results: Array<{ status: "success" | "failure"; result?: unknown }>;
      try {
        results = (await client.multicall({
          allowFailure: true,
          batchSize: 0,
          contracts: slice.map(({ note, asset }) =>
            asset.token
              ? { address: asset.token, abi: erc20Abi, functionName: "balanceOf", args: [note.safe] }
              : { address: multicall3, abi: MULTICALL3_BALANCE_ABI, functionName: "getEthBalance", args: [note.safe] },
          ),
        })) as Array<{ status: "success" | "failure"; result?: unknown }>;
      } catch (e) {
        console.warn("[Rescate] una tanda de lecturas falló entera:", e);
        failed += slice.length;
        return;
      } finally {
        onProgress?.(++done, chunks.length);
      }
      results.forEach((r, j) => {
        if (r.status !== "success") {
          failed++;
          return;
        }
        const balance = r.result as bigint;
        if (balance > 0n) holdings.push({ ...slice[j]!, balance });
      });
    };
    for (let i = 0; i < chunks.length; i += MULTICALL_PARALLEL) {
      await Promise.all(chunks.slice(i, i + MULTICALL_PARALLEL).map(readChunk));
    }
    return { holdings, failed };
  }
  const results = await Promise.allSettled(
    jobs.map(({ note, asset }) =>
      asset.token
        ? client.readContract({ address: asset.token, abi: erc20Abi, functionName: "balanceOf", args: [note.safe] })
        : client.getBalance({ address: note.safe }),
    ),
  );
  results.forEach((r, i) => {
    if (r.status === "rejected") {
      failed++;
      return;
    }
    const balance = r.value as bigint;
    if (balance > 0n) holdings.push({ ...jobs[i]!, balance });
  });
  return { holdings, failed };
}

/** Lecturas por petición a Multicall3 (cada una ~70 bytes: unas 35 KB de calldata). */
const MULTICALL_CHUNK = 500;
/** Tandas a la vez por red: pocas, para no chocar con el límite de un RPC público. */
const MULTICALL_PARALLEL = 4;
const MULTICALL3_BALANCE_ABI = [
  {
    type: "function",
    name: "getEthBalance",
    stateMutability: "view",
    inputs: [{ name: "addr", type: "address" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

const ERC4626_ABI = parseAbi([
  "function redeem(uint256 shares, address receiver, address owner) returns (uint256 assets)",
  "function maxRedeem(address owner) view returns (uint256)",
  "function previewRedeem(uint256 shares) view returns (uint256)",
  "function asset() view returns (address)",
]);

const SAFE_ABI = [
  { type: "function", name: "nonce", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "getOwners", stateMutability: "view", inputs: [], outputs: [{ type: "address[]" }] },
  {
    type: "function",
    name: "execTransaction",
    stateMutability: "payable",
    inputs: [
      { name: "to", type: "address" },
      { name: "value", type: "uint256" },
      { name: "data", type: "bytes" },
      { name: "operation", type: "uint8" },
      { name: "safeTxGas", type: "uint256" },
      { name: "baseGas", type: "uint256" },
      { name: "gasPrice", type: "uint256" },
      { name: "gasToken", type: "address" },
      { name: "refundReceiver", type: "address" },
      { name: "signatures", type: "bytes" },
    ],
    outputs: [{ type: "bool" }],
  },
] as const;

const SAFE_TX_TYPES = {
  SafeTx: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "data", type: "bytes" },
    { name: "operation", type: "uint8" },
    { name: "safeTxGas", type: "uint256" },
    { name: "baseGas", type: "uint256" },
    { name: "gasPrice", type: "uint256" },
    { name: "gasToken", type: "address" },
    { name: "refundReceiver", type: "address" },
    { name: "nonce", type: "uint256" },
  ],
} as const;

/** Lo que mueve una salida: a dónde, cuánto y con qué datos (transferencia simple). */
export function transferCall(asset: RescueAsset, to: Address, amount: bigint): { to: Address; value: bigint; data: Hex } {
  return asset.token
    ? { to: asset.token, value: 0n, data: encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [to, amount] }) }
    : { to, value: amount, data: "0x" };
}

/**
 * La transacción `execTransaction` del Safe, firmada por su dueño. Sin
 * reembolso de gas (gasPrice 0): lo paga quien la envía.
 */
export async function buildExecTransaction(params: {
  chainId: number;
  safe: Address;
  safeNonce: bigint;
  ownerKey: Hex;
  call: { to: Address; value: bigint; data: Hex };
}): Promise<{ to: Address; data: Hex; safeTxHash: Hex }> {
  const message = {
    to: params.call.to,
    value: params.call.value,
    data: params.call.data,
    operation: 0,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: zeroAddress,
    refundReceiver: zeroAddress,
    nonce: params.safeNonce,
  } as const;
  const domain = { chainId: params.chainId, verifyingContract: params.safe } as const;
  const owner = privateKeyToAccount(params.ownerKey);
  const signature = await owner.signTypedData({ domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message });
  const safeTxHash = hashTypedData({ domain, types: SAFE_TX_TYPES, primaryType: "SafeTx", message });
  return {
    to: params.safe,
    safeTxHash,
    data: encodeFunctionData({
      abi: SAFE_ABI,
      functionName: "execTransaction",
      args: [
        message.to,
        message.value,
        message.data,
        message.operation,
        message.safeTxGas,
        message.baseGas,
        message.gasPrice,
        message.gasToken,
        message.refundReceiver,
        signature,
      ],
    }),
  };
}

/**
 * Sacar participaciones de una bóveda ERC-4626: `redeem(participaciones,
 * destino, Safe)`, que manda al destino el activo de debajo (USDC, EURC…).
 */
export function redeemCall(asset: RescueAsset, to: Address, shares: bigint, safe: Address): { to: Address; value: bigint; data: Hex } {
  if (!asset.token || !asset.vault) throw new Error("redeemCall solo vale para una bóveda.");
  return {
    to: asset.token,
    value: 0n,
    data: encodeFunctionData({ abi: ERC4626_ABI, functionName: "redeem", args: [shares, to, safe] }),
  };
}

/** Cuántas participaciones deja sacar ahora la bóveda (su liquidez puede ser menor que el saldo). */
export async function vaultMaxRedeem(client: PublicClient, vault: Address, safe: Address): Promise<bigint> {
  return client.readContract({ address: vault, abi: ERC4626_ABI, functionName: "maxRedeem", args: [safe] });
}

/** Lo que valen unas participaciones en el activo de debajo, y cuál es (para decirlo). */
export async function vaultPreview(
  client: PublicClient,
  vault: Address,
  shares: bigint,
): Promise<{ assets: bigint; asset: Address; symbol: string; decimals: number }> {
  const [assets, asset] = await Promise.all([
    client.readContract({ address: vault, abi: ERC4626_ABI, functionName: "previewRedeem", args: [shares] }),
    client.readContract({ address: vault, abi: ERC4626_ABI, functionName: "asset" }),
  ]);
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: asset, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: asset, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return { assets, asset, symbol, decimals };
}

/** ¿Está desplegado el Safe en esta red? */
export async function isDeployed(client: PublicClient, safe: Address): Promise<boolean> {
  const code = await client.getCode({ address: safe });
  return !!code && code !== "0x";
}

/** La llamada que lo despliega (cualquier cuenta puede enviarla). */
export async function deployCall(note: RescueNote): Promise<{ to: Address; data: Hex }> {
  if (note.fluidkeyProfile) {
    const profile = fluidkeyProfile(note.fluidkeyProfile);
    if (fluidkeySafeAddress(note.owner, profile).toLowerCase() !== note.safe.toLowerCase()) {
      throw new Error("El despliegue no da la dirección esperada: no se envía.");
    }
    return fluidkeyDeployCall(note.owner, profile);
  }
  const d = await counterfactualSafeDeployment(note.owner);
  if (d.address.toLowerCase() !== note.safe.toLowerCase()) {
    throw new Error("El despliegue no da la dirección esperada: no se envía.");
  }
  return { to: d.factory, data: d.factoryData };
}

export async function safeNonce(client: PublicClient, safe: Address): Promise<bigint> {
  return client.readContract({ address: safe, abi: SAFE_ABI, functionName: "nonce" });
}

/** Una fila para exportar (CSV): con la clave del dueño solo si se pide. */
export function exportCsv(notes: RescueNote[], withKeys: boolean): string {
  // En modo Fluidkey cada nonce tiene un Safe por configuración: va su columna.
  const fk = notes.some((n) => n.fluidkeyProfile);
  const head = ["nonce", ...(fk ? ["configuracion"] : []), "safe", "dueno", ...(withKeys ? ["clave_privada_del_dueno"] : [])];
  const rows = notes.map((n) =>
    [n.nonce, ...(fk ? [n.fluidkeyProfile ?? ""] : []), n.safe, n.owner, ...(withKeys ? [n.ownerKey] : [])].join(","),
  );
  rows.unshift(head.join(","));
  return rows.join("\n") + "\n";
}

