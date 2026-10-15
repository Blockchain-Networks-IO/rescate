/**
 * WalletConnect en `rescate.html`, lado dApp: la página propone una sesión, la
 * billetera del móvil (o cualquiera con WalletConnect) escanea el QR, y la
 * sesión se envuelve como un proveedor EIP-1193 corriente. Así el resto de la
 * página (firmar el mensaje, pagar el gas) no sabe si la billetera es una
 * extensión o un móvil: mismo `connect`, mismo `createWalletClient`.
 *
 * Usa `@walletconnect/sign-client` a la MISMA versión que el `core` del
 * monedero (grupo acoplado `walletconnect` en `shared/upstreams/registro.ts`).
 * El Project ID es público por diseño; la página lo coge de la build, de
 * nuestra `/api/public-config` si se sirve desde nuestro dominio, o del que
 * pegue el usuario (es gratis en dashboard.reown.com): no puede depender de
 * que exista Mucho.
 */
import SignClient from "@walletconnect/sign-client";
import type { EIP1193Provider } from "viem";

export interface WcSession {
  provider: EIP1193Provider;
  /** Las cuentas que la billetera expuso (sin repetir, en su orden). */
  accounts: string[];
  /** Nombre de la billetera, si lo dice. */
  peerName: string;
  disconnect(): Promise<void>;
}

const METHODS = ["personal_sign", "eth_sendTransaction", "wallet_switchEthereumChain"];
const EVENTS = ["chainChanged", "accountsChanged"];

/** `eip155:42161:0xabc…` → { chainId, address }. Pura. */
export function parseCaipAccount(caip: string): { chainId: number; address: string } | null {
  const [ns, chain, address] = caip.split(":");
  if (ns !== "eip155" || !chain || !address) return null;
  const chainId = Number(chain);
  return Number.isInteger(chainId) && chainId > 0 ? { chainId, address } : null;
}

/** Cuentas únicas y redes aprobadas de una sesión. Pura. */
export function sessionAccounts(caipAccounts: string[]): { accounts: string[]; chains: number[] } {
  const accounts: string[] = [];
  const chains: number[] = [];
  for (const c of caipAccounts) {
    const p = parseCaipAccount(c);
    if (!p) continue;
    if (!accounts.some((a) => a.toLowerCase() === p.address.toLowerCase())) accounts.push(p.address);
    if (!chains.includes(p.chainId)) chains.push(p.chainId);
  }
  return { accounts, chains };
}

function rpcError(code: number, message: string): Error & { code: number } {
  return Object.assign(new Error(message), { code });
}

/**
 * Propone la sesión y espera a que la billetera la apruebe. `onUri` recibe el
 * `wc:` que hay que enseñar como QR (o abrir como enlace en el móvil).
 */
/** Cuánto se espera a tener el QR: sin relay, `init` reintenta sin fin. */
const PAIRING_TIMEOUT_MS = 20_000;

function withTimeout<T>(p: Promise<T>, ms: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function connectWalletConnect(params: {
  projectId: string;
  chainIds: number[];
  onUri: (uri: string) => void;
}): Promise<WcSession> {
  const { client, uri, approval } = await withTimeout(
    propose(params),
    PAIRING_TIMEOUT_MS,
    "no se ha podido contactar con el servicio de WalletConnect (revisa la conexión, o que el Project ID sea válido y admita esta web).",
  );
  params.onUri(uri);
  return finish(client, await approval(), params.chainIds);
}

async function propose(params: { projectId: string; chainIds: number[] }) {
  const client = await SignClient.init({
    projectId: params.projectId,
    metadata: {
      name: "Rescate de direcciones de depósito",
      description: "Recupera lo que tengas en tus direcciones de depósito de Mucho.",
      url:
        typeof location !== "undefined" && location.protocol.startsWith("http")
          ? location.origin
          : "https://wallet.mucho.finance",
      icons: [],
    },
  });
  const chains = params.chainIds.map((id) => `eip155:${id}`);
  const { uri, approval } = await client.connect({
    // Opcionales: muchas billeteras rechazan la sesión entera si una red
    // REQUERIDA no la tienen; así aprueban las que tengan.
    optionalNamespaces: { eip155: { chains, methods: METHODS, events: EVENTS } },
  });
  if (!uri) throw new Error("WalletConnect no ha dado el código para emparejar.");
  return { client, uri, approval };
}

function finish(
  client: InstanceType<typeof SignClient>,
  session: Awaited<ReturnType<Awaited<ReturnType<InstanceType<typeof SignClient>["connect"]>>["approval"]>>,
  chainIds: number[],
): WcSession {
  const caip = Object.values(session.namespaces).flatMap((n) => n.accounts);
  const { accounts, chains: approved } = sessionAccounts(caip);
  if (!accounts.length) throw new Error("La billetera no ha dado ninguna cuenta EVM.");

  let current = approved.includes(chainIds[0]!) ? chainIds[0]! : approved[0]!;
  const listeners = new Map<string, Set<(...a: unknown[]) => void>>();
  const emit = (event: string, ...args: unknown[]) => listeners.get(event)?.forEach((fn) => fn(...args));

  const provider = {
    async request({ method, params: p }: { method: string; params?: unknown }) {
      switch (method) {
        case "eth_requestAccounts":
        case "eth_accounts":
          return accounts;
        case "eth_chainId":
          return `0x${current.toString(16)}`;
        case "wallet_switchEthereumChain": {
          const want = Number((p as Array<{ chainId: string }>)?.[0]?.chainId);
          // Solo entre las redes que la billetera aprobó: pedir otra sería
          // una petición que la sesión no cubre.
          if (!approved.includes(want)) {
            throw rpcError(4902, "Tu billetera no ha aprobado esa red en WalletConnect. Vuelve a conectar y acéptala.");
          }
          current = want;
          emit("chainChanged", `0x${want.toString(16)}`);
          return null;
        }
        case "wallet_addEthereumChain":
          throw rpcError(4200, "Por WalletConnect no se pueden añadir redes: vuelve a conectar aceptando esa red.");
        default:
          return client.request({
            topic: session.topic,
            chainId: `eip155:${current}`,
            request: { method, params: p as unknown[] },
          });
      }
    },
    on(event: string, fn: (...a: unknown[]) => void) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event)!.add(fn);
    },
    removeListener(event: string, fn: (...a: unknown[]) => void) {
      listeners.get(event)?.delete(fn);
    },
  } as unknown as EIP1193Provider;

  return {
    provider,
    accounts,
    peerName: session.peer?.metadata?.name || "Billetera por WalletConnect",
    async disconnect() {
      await client
        .disconnect({ topic: session.topic, reason: { code: 6000, message: "Desconectado" } })
        .catch((e: unknown) => console.warn("[Rescate] no se pudo cerrar la sesión de WalletConnect:", e));
    },
  };
}
