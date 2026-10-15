/**
 * rescate.html — sacar el dinero de las direcciones de depósito SIN Mucho
 * (`docs/RESCATE-DIRECCIONES-DE-DEPOSITO.md`). Un único fichero, generado en
 * `pnpm build` por `scripts/build-rescue.ts`, con los mismos módulos del
 * monedero. Sin React a propósito: tiene que poder abrirse dentro de diez años.
 *
 * De dónde sale la firma (la clave de todo): una billetera del navegador
 * (MetaMask, Rabby, OKX, la extensión de OneKey… y un Ledger a través de
 * ellas), una firma hecha fuera y pegada, la clave privada de la cuenta o,
 * como último recurso, la frase. La frase y las claves no salen de la pestaña.
 */
import {
  createPublicClient,
  createWalletClient,
  custom,
  formatUnits,
  getAddress,
  http,
  isAddress,
  isHex,
  recoverMessageAddress,
  type Address,
  type EIP1193Provider,
  type Hex,
  type WalletClient,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { erc20Abi } from "viem";
import { getChain, type ChainKey } from "@shared/wallet/chains";
import { buildStealthKeygenMessage, type StealthMasterKeys } from "@/lib/web3/stealth/derive";
import { checkMnemonic, masterKeyCandidates, seedEvmAccount } from "@/lib/web3/stealth/rescue";
import { createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QRCodeSVG } from "qrcode.react";
import { connectWalletConnect, type WcSession } from "./walletConnect";
import {
  RESCUE_CHAINS,
  assetsFor,
  buildExecTransaction,
  deployCall,
  exportCsv,
  isDeployed,
  readHoldings,
  rescueChain,
  rescueClient,
  rescueNotes,
  safeNonce,
  transferCall,
  type RescueAsset,
  type RescueHolding,
  type RescueNote,
} from "./core";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (t: string) =>
  t.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

function say(id: string, text: string, kind: "ok" | "bad" | "info" = "info") {
  $(id).innerHTML = `<p class="${kind}">${esc(text)}</p>`;
}
function log(text: string, kind: "ok" | "bad" | "info" = "info") {
  const p = document.createElement("p");
  p.className = kind;
  p.textContent = text;
  $("movelog").appendChild(p);
}

// ── Billeteras del navegador (EIP-6963, y window.ethereum si no anuncia) ──
interface Announced {
  info: { name: string; uuid: string; icon?: string };
  provider: EIP1193Provider;
}
const wallets: Announced[] = [];
window.addEventListener("eip6963:announceProvider", (e) => {
  const d = (e as CustomEvent<Announced>).detail;
  if (d && !wallets.some((w) => w.info.uuid === d.info.uuid)) {
    wallets.push(d);
    paintWallets();
  }
});
window.dispatchEvent(new Event("eip6963:requestProvider"));
setTimeout(() => {
  const eth = (window as unknown as { ethereum?: EIP1193Provider }).ethereum;
  if (!wallets.length && eth) {
    wallets.push({ info: { name: "Billetera del navegador", uuid: "window.ethereum" }, provider: eth });
  }
  paintWallets();
}, 500);

function paintWallets() {
  const box = $("wallets");
  box.innerHTML = wallets.length
    ? ""
    : location.protocol === "file:"
      ? `<div class="info"><p><b>No se ve ninguna billetera.</b> Has abierto el fichero desde tu ordenador, y las extensiones no entran en ficheros locales salvo que se lo permitas:</p>
         <ol><li>Abre la página de extensiones: en Chrome <code>chrome://extensions</code>, en Brave <code>brave://extensions</code>, en Edge <code>edge://extensions</code>.</li>
         <li>Busca tu billetera (Rabby, MetaMask…) y pulsa <b>Detalles</b>.</li>
         <li>Activa <b>«Permitir el acceso a las URL de archivo»</b>.</li>
         <li>Vuelve aquí y recarga la página.</li></ol>
         <p>Si no puedes, usa <b>WalletConnect</b> (abajo), que funciona igual desde el fichero, o pega una firma, la clave o la frase.</p></div>`
      : `<p class="muted">No se ve ninguna billetera en este navegador. Usa WalletConnect o las otras opciones.</p>`;
  for (const w of wallets) {
    const b = document.createElement("button");
    b.textContent = `Conectar ${w.info.name}`;
    b.onclick = () => void connect(w);
    box.appendChild(b);
  }
  const wc = document.createElement("button");
  wc.textContent = "WalletConnect (billetera del móvil u otra)";
  wc.onclick = () => void connectWc();
  box.appendChild(wc);
}

// ── WalletConnect ──
// Project ID: el de la build, el de nuestra web si se sirve desde ella, o el
// que pegue el usuario (gratis en dashboard.reown.com). Es público por diseño.
declare const __RESCUE_WC_PROJECT_ID__: string;
async function defaultWcProjectId(): Promise<string> {
  if (__RESCUE_WC_PROJECT_ID__) return __RESCUE_WC_PROJECT_ID__;
  // El que deja escrito la descarga desde el monedero (`RescateDepositosPage`).
  const meta = document.querySelector<HTMLMetaElement>('meta[name="wc-project-id"]')?.content?.trim();
  if (meta) return meta;
  if (!location.protocol.startsWith("http")) return "";
  try {
    const base = location.pathname.replace(/\/[^/]*$/, "");
    const r = await fetch(`${base}/api/public-config`);
    const j = (await r.json()) as { walletConnect?: { projectId?: string } };
    return j.walletConnect?.projectId ?? "";
  } catch (e) {
    console.warn("[Rescate] sin Project ID de WalletConnect de esta web:", e);
    return "";
  }
}

let wcSession: WcSession | null = null;
let qrRoot: Root | null = null;

function paintQr(uri: string | null) {
  const box = $("wcqr");
  if (!uri) {
    qrRoot?.unmount();
    qrRoot = null;
    box.innerHTML = "";
    return;
  }
  box.innerHTML = `<div id="wcqrsvg" style="background:#fff;padding:12px;display:inline-block;border-radius:8px"></div>
    <p class="muted">Escanéalo con tu billetera (en su lector de WalletConnect). En el móvil: <a href="${esc(uri)}">abrir en la billetera</a> · <button id="wccopy">Copiar el código</button></p>`;
  qrRoot = createRoot($("wcqrsvg"));
  qrRoot.render(createElement(QRCodeSVG, { value: uri, size: 240 }));
  $("wccopy").onclick = () => void navigator.clipboard.writeText(uri);
}

async function connectWc() {
  const input = $<HTMLInputElement>("wcproject");
  let projectId = input.value.trim();
  if (!projectId) {
    projectId = await defaultWcProjectId();
    input.value = projectId;
  }
  if (!projectId) {
    $("wcprojectrow").hidden = false;
    return say(
      "keysres",
      "Para WalletConnect hace falta un Project ID: crea uno gratis en dashboard.reown.com, pégalo arriba y vuelve a pulsar.",
      "bad",
    );
  }
  try {
    await wcSession?.disconnect();
    say("keysres", "Escanea el QR con tu billetera y acepta la conexión…");
    wcSession = await connectWalletConnect({
      projectId,
      chainIds: RESCUE_CHAINS.map((c) => getChain(c).evmChainId!).filter(Boolean),
      onUri: paintQr,
    });
    paintQr(null);
    await connect({ info: { name: wcSession.peerName, uuid: "walletconnect" }, provider: wcSession.provider });
  } catch (e) {
    paintQr(null);
    $("wcprojectrow").hidden = false;
    say("keysres", `No se pudo conectar por WalletConnect: ${(e as Error).message}`, "bad");
  }
}

let connected: { provider: EIP1193Provider; address: Address; name: string } | null = null;

async function connect(w: Announced) {
  try {
    const accounts = (await w.provider.request({ method: "eth_requestAccounts" })) as string[];
    if (!accounts?.length) throw new Error("La billetera no ha dado ninguna cuenta.");
    const sel = $<HTMLSelectElement>("walletaccount");
    sel.innerHTML = accounts.map((a) => `<option value="${esc(getAddress(a))}">${esc(getAddress(a))}</option>`).join("");
    connected = { provider: w.provider, address: getAddress(accounts[0]!), name: w.info.name };
    sel.onchange = () => {
      if (connected) connected.address = getAddress(sel.value);
    };
    $("walletsign").hidden = false;
    $("payerwallet").textContent = `Pagar el gas con ${w.info.name}`;
    $<HTMLInputElement>("payerwalletradio").disabled = false;
    say("keysres", `Conectada ${w.info.name}. Elige la cuenta que era tu cuenta de Mucho y pulsa «Firmar».`);
  } catch (e) {
    say("keysres", `No se pudo conectar: ${(e as Error).message}`, "bad");
  }
}

// ── Las claves de la capa ──
let keySets: StealthMasterKeys[] | null = null;
let anchor: Address | null = null;

function useSignature(address: Address, signature: Hex) {
  keySets = masterKeyCandidates(signature);
  anchor = address;
  say(
    "keysres",
    `Claves calculadas para ${address}. Ahora busca. (Meta-dirección: ${keySets[0]!.metaAddress.slice(0, 26)}…)`,
    "ok",
  );
  $("search").hidden = false;
}

async function signWithWallet() {
  if (!connected) return;
  try {
    const client = createWalletClient({ account: connected.address, transport: custom(connected.provider) });
    const message = buildStealthKeygenMessage({ address: connected.address });
    const signature = await client.signMessage({ account: connected.address, message });
    useSignature(connected.address, signature);
  } catch (e) {
    say("keysres", `No se firmó: ${(e as Error).message}`, "bad");
  }
}

function showMessageToSign() {
  const a = $<HTMLInputElement>("pasteaddr").value.trim();
  $<HTMLTextAreaElement>("pastemsg").value = isAddress(a) ? buildStealthKeygenMessage({ address: getAddress(a) }) : "";
}

async function usePasted() {
  const a = $<HTMLInputElement>("pasteaddr").value.trim();
  const sig = $<HTMLInputElement>("pastesig").value.trim();
  if (!isAddress(a)) return say("keysres", "Esa dirección no es válida.", "bad");
  if (!isHex(sig) || sig.length !== 132) return say("keysres", "La firma tiene que ser 0x seguido de 130 caracteres.", "bad");
  const address = getAddress(a);
  const message = buildStealthKeygenMessage({ address });
  const signer = await recoverMessageAddress({ message, signature: sig as Hex }).catch(() => null);
  if (signer !== address) {
    return say("keysres", "Esa firma no es de esa dirección sobre el mensaje de arriba. Revisa que firmaste el texto EXACTO.", "bad");
  }
  useSignature(address, sig as Hex);
}

async function useKey() {
  const k = $<HTMLInputElement>("pkey").value.trim();
  const key = (k.startsWith("0x") ? k : `0x${k}`) as Hex;
  try {
    const acc = privateKeyToAccount(key);
    const signature = await acc.signMessage({ message: buildStealthKeygenMessage({ address: acc.address }) });
    $<HTMLInputElement>("pkey").value = "";
    useSignature(acc.address, signature);
  } catch {
    say("keysres", "Esa clave privada no es válida.", "bad");
  }
}

async function useSeed() {
  const m = checkMnemonic($<HTMLTextAreaElement>("seed").value);
  if (!m.ok) return say("keysres", m.reason, "bad");
  const index = Math.max(0, Number($<HTMLInputElement>("seedindex").value || "1") - 1);
  const acc = seedEvmAccount(m.mnemonic, index);
  const signature = await acc.signMessage({ message: buildStealthKeygenMessage({ address: acc.address }) });
  $<HTMLTextAreaElement>("seed").value = "";
  useSignature(acc.address, signature);
}

// ── Buscar ──
let notes: RescueNote[] = [];
let holdings: Array<RescueHolding & { chain: ChainKey; deployed: boolean }> = [];

function selectedChains(): ChainKey[] {
  return RESCUE_CHAINS.filter((c) => $<HTMLInputElement>(`chain-${c}`).checked);
}
function rpcOf(c: ChainKey): string {
  return $<HTMLInputElement>(`rpc-${c}`).value.trim();
}

async function extraAssets(): Promise<RescueAsset[]> {
  const chain = $<HTMLSelectElement>("extrachain").value as ChainKey;
  const token = $<HTMLInputElement>("extratoken").value.trim();
  if (!token) return [];
  if (!isAddress(token)) throw new Error("El contrato del token añadido no es una dirección válida.");
  const client = rescueClient(chain, rpcOf(chain));
  const [symbol, decimals] = await Promise.all([
    client.readContract({ address: token, abi: erc20Abi, functionName: "symbol" }),
    client.readContract({ address: token, abi: erc20Abi, functionName: "decimals" }),
  ]);
  return [{ chain, symbol, token: getAddress(token), decimals }];
}

async function search() {
  if (!keySets) return;
  const count = Math.min(500, Math.max(1, Number($<HTMLInputElement>("count").value || "40")));
  $("searchres").innerHTML = `<p class="info">Calculando ${count} direcciones y leyendo saldos…</p>`;
  try {
    notes = await rescueNotes(keySets, count);
    const extra = await extraAssets();
    holdings = [];
    const failures: string[] = [];
    for (const chain of selectedChains()) {
      const client = rescueClient(chain, rpcOf(chain));
      const { holdings: found, failed } = await readHoldings(client, notes, assetsFor(chain, extra));
      if (failed) failures.push(`${getChain(chain).name}: ${failed} lecturas fallidas`);
      for (const h of found) {
        holdings.push({ ...h, chain, deployed: await isDeployed(client, h.note.safe).catch(() => false) });
      }
    }
    paintHoldings(failures);
  } catch (e) {
    say("searchres", `No se pudo buscar: ${(e as Error).message}`, "bad");
  }
}

function paintHoldings(failures: string[]) {
  const box = $("searchres");
  const parts: string[] = [];
  if (failures.length) {
    parts.push(
      `<p class="bad">Hay lecturas que fallaron (no es que estén vacías): ${esc(failures.join(" · "))}. Prueba otro RPC y vuelve a buscar.</p>`,
    );
  }
  if (!holdings.length && failures.length) {
    // Sin saldo LEÍDO no se afirma que no haya: ya se ha dicho qué falló.
  } else if (!holdings.length) {
    parts.push(
      `<p class="info">No hay saldo en estas ${notes.length / (keySets?.length || 1)} direcciones en las redes elegidas. Si sabes que tenías, sube «cuántas direcciones», añade el token o revisa que firmaste con la cuenta correcta.</p>`,
    );
  } else {
    // Si solo uno de los dos juegos de claves tiene saldo, es el bueno: se dice.
    const sets = new Set(holdings.map((h) => h.note.keySet));
    parts.push(`<p class="ok">Encontrado saldo en ${holdings.length} ${holdings.length === 1 ? "sitio" : "sitios"}.</p>`);
    parts.push(
      "<table><tr><th>Dirección nº</th><th>Red</th><th>Cantidad</th><th>Safe</th><th>Desplegado</th></tr>" +
        holdings
          .map((h) => {
            const c = getChain(h.chain);
            const link = c.explorer ? `${c.explorer}/address/${h.note.safe}` : "#";
            return `<tr><td>${h.note.nonce + 1}${sets.size > 1 ? ` (${h.note.keySet + 1})` : ""}</td><td>${esc(c.name)}</td><td>${esc(
              formatUnits(h.balance, h.asset.decimals),
            )} ${esc(h.asset.symbol)}</td><td><a href="${esc(link)}" target="_blank" rel="noreferrer"><code>${h.note.safe.slice(
              0,
              10,
            )}…</code></a></td><td>${h.deployed ? "sí" : "no (se despliega al sacar)"}</td></tr>`;
          })
          .join("") +
        "</table>",
    );
    $("move").hidden = false;
  }
  box.innerHTML = parts.join("");
  $("export").hidden = false;
}

// ── Sacar ──
async function payerFor(chain: ChainKey): Promise<{ client: WalletClient; address: Address }> {
  const viemChain = rescueChain(chain, rpcOf(chain));
  if ($<HTMLInputElement>("payerwalletradio").checked) {
    if (!connected) throw new Error("Conecta una billetera para pagar el gas.");
    const client = createWalletClient({ account: connected.address, chain: viemChain, transport: custom(connected.provider) });
    const current = await client.getChainId();
    if (current !== viemChain.id) {
      try {
        await client.switchChain({ id: viemChain.id });
      } catch {
        await client.addChain({ chain: viemChain });
        await client.switchChain({ id: viemChain.id });
      }
    }
    return { client, address: connected.address };
  }
  const k = $<HTMLInputElement>("payerkey").value.trim();
  const account = privateKeyToAccount((k.startsWith("0x") ? k : `0x${k}`) as Hex);
  return {
    client: createWalletClient({ account, chain: viemChain, transport: http(viemChain.rpcUrls.default.http[0]) }),
    address: account.address,
  };
}

/**
 * Espera la confirmación por el RPC público y, si este falla, por la propia
 * billetera conectada (que ya está en esa red): una transacción enviada no
 * puede quedarse en «falló» solo porque el RPC de lectura no contestó.
 */
async function waitReceipt(reader: ReturnType<typeof rescueClient>, hash: Hex) {
  try {
    return await reader.waitForTransactionReceipt({ hash, timeout: 180_000 });
  } catch (e) {
    if (!connected || !$<HTMLInputElement>("payerwalletradio").checked) throw e;
    console.warn("[Rescate] el RPC público no confirmó; se pregunta a la billetera:", e);
    const viaWallet = createPublicClient({ transport: custom(connected.provider) });
    return viaWallet.waitForTransactionReceipt({ hash, timeout: 180_000 });
  }
}

/** El motivo legible de un error de viem: lo corto, el detalle y a qué web se preguntó. */
function describeError(e: unknown): string {
  const err = e as { shortMessage?: string; details?: string; url?: string; message?: string };
  const parts = [err.shortMessage ?? err.message?.split("\n")[0] ?? "error desconocido"];
  if (err.details && !parts[0]!.includes(err.details)) parts.push(err.details);
  if (err.url) {
    try {
      parts.push(`(RPC: ${new URL(err.url).host})`);
    } catch {
      /* url no válida: no se añade */
    }
  }
  return parts.join(" — ");
}

async function moveAll() {
  const dest = $<HTMLInputElement>("dest").value.trim();
  if (!isAddress(dest)) return log("La dirección de destino no es válida.", "bad");
  if (!$<HTMLInputElement>("linkok").checked) return log("Marca antes la casilla de que se unen los cobros.", "bad");
  const to = getAddress(dest);
  $<HTMLButtonElement>("moveall").disabled = true;
  try {
    for (const h of holdings) {
      const c = getChain(h.chain);
      const label = `${formatUnits(h.balance, h.asset.decimals)} ${h.asset.symbol} de la dirección nº ${h.note.nonce + 1} en ${c.name}`;
      try {
        const reader = rescueClient(h.chain, rpcOf(h.chain));
        const payer = await payerFor(h.chain);
        if (!(await isDeployed(reader, h.note.safe))) {
          log(`Desplegando el Safe de la dirección nº ${h.note.nonce + 1} en ${c.name}…`);
          const d = await deployCall(h.note);
          const hash = await payer.client.sendTransaction({
            account: payer.client.account ?? payer.address,
            chain: payer.client.chain,
            to: d.to,
            data: d.data,
          });
          log(`Despliegue enviado: ${hash}. Esperando a que se confirme…`);
          const deployed = await waitReceipt(reader, hash);
          if (deployed.status !== "success") throw new Error(`el despliegue revirtió (${hash}).`);
        }
        // El saldo de ahora (puede haber cambiado desde la búsqueda).
        const balance = h.asset.token
          ? await reader.readContract({ address: h.asset.token, abi: erc20Abi, functionName: "balanceOf", args: [h.note.safe] })
          : await reader.getBalance({ address: h.note.safe });
        if (balance === 0n) {
          log(`${label}: ya está vacío.`, "info");
          continue;
        }
        const exec = await buildExecTransaction({
          chainId: c.evmChainId!,
          safe: h.note.safe,
          safeNonce: await safeNonce(reader, h.note.safe),
          ownerKey: h.note.ownerKey,
          call: transferCall(h.asset, to, balance),
        });
        const hash = await payer.client.sendTransaction({
          account: payer.client.account ?? payer.address,
          chain: payer.client.chain,
          to: exec.to,
          data: exec.data,
        });
        log(`${label}: enviada ${hash}. Esperando a que se confirme…`);
        const receipt = await waitReceipt(reader, hash);
        log(
          receipt.status === "success" ? `${label}: enviado (${hash}).` : `${label}: la transacción revirtió (${hash}).`,
          receipt.status === "success" ? "ok" : "bad",
        );
      } catch (e) {
        console.error("[Rescate]", label, e);
        log(`${label}: ${describeError(e)} Vuelve a pulsar «Mover todo»: lo ya hecho no se repite.`, "bad");
      }
    }
    log("Terminado. Vuelve a «Buscar» para comprobar que no queda nada.", "info");
  } finally {
    $<HTMLButtonElement>("moveall").disabled = false;
  }
}

function download() {
  const withKeys = $<HTMLInputElement>("withkeys").checked;
  const blob = new Blob([exportCsv(notes, withKeys)], { type: "text/csv" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `direcciones-de-deposito-${anchor ?? "cuenta"}.csv`;
  a.click();
}

// ── Montaje ──
function mount() {
  const chainsBox = $("chains");
  chainsBox.innerHTML = RESCUE_CHAINS.map((c) => {
    const ch = getChain(c);
    const on = c === "arbitrum" || c === "base";
    return `<label class="chain"><input type="checkbox" id="chain-${c}" ${on ? "checked" : ""}> ${esc(ch.name)} <input class="rpc" id="rpc-${c}" placeholder="${esc(ch.defaultRpcUrl ?? "RPC")}"></label>`;
  }).join("");
  $("extrachain").innerHTML = RESCUE_CHAINS.map((c) => `<option value="${c}">${esc(getChain(c).name)}</option>`).join("");
  $("walletsignbtn").onclick = () => void signWithWallet();
  $("pasteaddr").oninput = showMessageToSign;
  $("pastebtn").onclick = () => void usePasted();
  $("pkeybtn").onclick = () => void useKey();
  $("seedbtn").onclick = () => void useSeed();
  $("searchbtn").onclick = () => void search();
  $("moveall").onclick = () => void moveAll();
  $("exportbtn").onclick = download;
}
mount();
