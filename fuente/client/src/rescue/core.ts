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

/** Redes donde se buscan, en este orden. HyperEVM y Robinhood van aparte (sin indexador ni prisa). */
export const RESCUE_CHAINS: ChainKey[] = ["arbitrum", "base", "ethereum", "optimism", "polygon", "bnb", "hyperevm"];

export interface RescueNote {
  /** Juego de claves (0 = forma de la firma tal cual, 1 = la otra `s`). */
  keySet: number;
  nonce: number;
  owner: Address;
  ownerKey: Hex;
  safe: Address;
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

/** Los RPC que se usan, en orden: el elegido (o el de por defecto) y el de respaldo. */
export function rescueRpcUrls(chain: ChainKey, rpcUrl?: string): string[] {
  const first = rescueChain(chain, rpcUrl).rpcUrls.default.http[0]!;
  const backup = BACKUP_RPC[chain];
  return backup && backup !== first ? [first, backup] : [first];
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
): Promise<{ holdings: RescueHolding[]; failed: number }> {
  const holdings: RescueHolding[] = [];
  let failed = 0;
  const jobs = notes.flatMap((note) => assets.map((asset) => ({ note, asset })));
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

/** ¿Está desplegado el Safe en esta red? */
export async function isDeployed(client: PublicClient, safe: Address): Promise<boolean> {
  const code = await client.getCode({ address: safe });
  return !!code && code !== "0x";
}

/** La llamada que lo despliega (cualquier cuenta puede enviarla). */
export async function deployCall(note: RescueNote): Promise<{ to: Address; data: Hex }> {
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
  const head = withKeys ? "nonce,safe,dueno,clave_privada_del_dueno" : "nonce,safe,dueno";
  const rows = notes.map((n) =>
    withKeys ? `${n.nonce},${n.safe},${n.owner},${n.ownerKey}` : `${n.nonce},${n.safe},${n.owner}`,
  );
  return [head, ...rows].join("\n") + "\n";
}
