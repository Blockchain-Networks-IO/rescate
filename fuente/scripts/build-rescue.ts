/**
 * build-rescue — empaqueta `client/src/rescue/standalone.ts` en UN solo fichero
 * HTML sin dependencias externas (`client/public/rescate.html`), que Vite copia
 * tal cual a `dist/public`. Es la herramienta para sacar el dinero de las
 * direcciones de depósito SIN Mucho (`docs/RESCATE-DIRECCIONES-DE-DEPOSITO.md`).
 * Se ejecuta en `pnpm build` (antes de vite) y a mano con `pnpm build:rescue`.
 *
 * Usa los MISMOS módulos que el monedero (alias @shared y @): la dirección de
 * cada Safe sale del mismo código que la calcula el monedero.
 */
import { build } from "esbuild";
import { mkdirSync, writeFileSync } from "fs";
import { resolve } from "path";

const root = resolve(import.meta.dirname ?? ".", "..");

const result = await build({
  entryPoints: [resolve(root, "client/src/rescue/standalone.ts")],
  inject: [resolve(root, "client/src/rescue/bufferShim.ts")],
  bundle: true,
  write: false,
  format: "iife",
  platform: "browser",
  target: ["es2020"],
  minify: true,
  legalComments: "none",
  // Qué ficheros entran en el paquete: lo usa `publish-rescue.ts` para publicar
  // nuestro código fuente y las versiones de las dependencias junto al HTML.
  metafile: true,
  alias: { "@shared": resolve(root, "shared"), "@": resolve(root, "client/src") },
  define: {
    "process.env.NODE_ENV": '"production"',
    global: "globalThis",
    // Público por diseño; si la build no lo trae, la página lo pide a nuestra
    // web o al usuario (ver `client/src/rescue/standalone.ts`).
    __RESCUE_WC_PROJECT_ID__: JSON.stringify(
      process.env.REOWN_PROJECT_ID || process.env.VITE_REOWN_PROJECT_ID || process.env.WALLETCONNECT_PROJECT_ID || "",
    ),
  },
});
const js = result.outputFiles[0].text.replace(/<\/script/gi, "<\\/script");

const html = `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Rescate de direcciones de depósito</title>
<meta name="wc-project-id" content="">
<style>
  :root{color-scheme:light dark}
  [hidden]{display:none!important}
  body{font:15px/1.45 system-ui,sans-serif;max-width:900px;margin:2rem auto;padding:0 1rem;color:#222;background:#fafafa}
  @media(prefers-color-scheme:dark){body{color:#e6e6e6;background:#111}}
  h1{font-size:1.4rem;margin:0 0 .25rem} h2{font-size:1.1rem;margin:1.6rem 0 .4rem}
  .muted{opacity:.7;font-size:.9rem}
  textarea,input{font:13px/1.4 ui-monospace,monospace;padding:.45rem;box-sizing:border-box;border:1px solid #888;border-radius:6px;background:transparent;color:inherit}
  textarea{width:100%;min-height:80px} input.wide{width:100%}
  .row{display:flex;flex-wrap:wrap;gap:.6rem;align-items:center;margin:.6rem 0}
  button{font:inherit;padding:.5rem .9rem;border:1px solid #888;border-radius:6px;background:transparent;color:inherit;cursor:pointer}
  button:hover{background:rgba(128,128,128,.15)} button:disabled{opacity:.5;cursor:default}
  .ok,.bad,.info{margin:.35rem 0;padding:.45rem .6rem;border-radius:6px;word-break:break-word}
  .ok{background:rgba(16,160,80,.15)} .bad{background:rgba(200,40,40,.15)} .info{background:rgba(128,128,128,.12)}
  fieldset{border:1px solid rgba(128,128,128,.4);border-radius:8px;margin:.8rem 0;padding:.6rem .9rem}
  legend{font-weight:600}
  label.chain{display:flex;gap:.5rem;align-items:center;margin:.25rem 0} input.rpc{flex:1;min-width:0}
  table{border-collapse:collapse;width:100%;font-size:.9rem} td,th{border-bottom:1px solid rgba(128,128,128,.3);padding:.3rem;text-align:left}
  code{font-family:ui-monospace,monospace} details{margin-top:1.5rem}
</style>
</head>
<body>
<h1>Rescate de direcciones de depósito</h1>
<p class="muted">Para sacar lo que tengas en tus direcciones de depósito de Mucho aunque Mucho no exista. Todo se calcula en este navegador: no se envía nada a ningún servidor salvo las lecturas y transacciones al RPC de cada red, que puedes cambiar por el tuyo.</p>

<h2>1. Tus claves</h2>
<p class="muted">Las direcciones de depósito de cada cuenta salen de UNA firma de esa cuenta sobre un mensaje fijo. Consíguela de cualquiera de estas formas (la primera es la más cómoda y no te pide la frase):</p>
<fieldset><legend>Conectar una billetera</legend>
  <p class="muted">MetaMask, Rabby, OKX, la extensión de OneKey… (y un Ledger a través de ellas), o la billetera del móvil por WalletConnect, con tu frase de Mucho importada; o el aparato que usabas en Mucho.</p>
  <div class="row" id="wallets"></div>
  <div class="row" id="wcprojectrow" hidden>Project ID de WalletConnect <input id="wcproject" placeholder="de dashboard.reown.com" style="flex:1"></div>
  <div id="wcqr"></div>
  <div class="row" id="walletsign" hidden>
    <select id="walletaccount"></select>
    <button id="walletsignbtn">Firmar</button>
  </div>
</fieldset>
<fieldset><legend>Pegar una firma hecha en otra billetera</legend>
  <div class="row"><input class="wide" id="pasteaddr" placeholder="Dirección de la cuenta (0x…)"></div>
  <p class="muted">Firma EXACTAMENTE este texto («firmar mensaje») con esa cuenta y pega la firma:</p>
  <textarea id="pastemsg" readonly></textarea>
  <div class="row"><input class="wide" id="pastesig" placeholder="Firma (0x…)"><button id="pastebtn">Usar esta firma</button></div>
</fieldset>
<fieldset><legend>Clave privada de la cuenta</legend>
  <div class="row"><input class="wide" id="pkey" type="password" autocomplete="off" placeholder="0x…"><button id="pkeybtn">Usar</button></div>
</fieldset>
<fieldset><legend>Frase de recuperación (último recurso)</legend>
  <textarea id="seed" autocomplete="off" spellcheck="false" placeholder="palabra1 palabra2 …"></textarea>
  <div class="row">Cuenta nº <input id="seedindex" type="number" min="1" value="1" style="width:5rem"><button id="seedbtn">Usar</button></div>
</fieldset>
<div id="keysres"></div>

<div id="search" hidden>
<h2>2. Buscar</h2>
<div class="row">Cuántas direcciones mirar <input id="count" type="number" min="1" max="500" value="40" style="width:6rem"></div>
<div id="chains"></div>
<div class="row">Añadir un token: <select id="extrachain"></select> <input id="extratoken" placeholder="contrato 0x…" style="flex:1"></div>
<div class="row"><button id="searchbtn">Buscar</button></div>
<div id="searchres"></div>
</div>

<div id="move" hidden>
<h2>3. Sacarlo</h2>
<div class="row"><input class="wide" id="dest" placeholder="Dirección de destino (0x…), la misma vale en todas las redes"></div>
<fieldset><legend>Quién paga el gas</legend>
  <label><input type="radio" name="payer" id="payerwalletradio" checked disabled> <span id="payerwallet">La billetera conectada</span></label><br>
  <label><input type="radio" name="payer" id="payerkeyradio"> Una clave con un poco de moneda nativa en cada red: <input id="payerkey" type="password" autocomplete="off" placeholder="0x…"></label>
  <p class="muted">El gas lo paga esa cuenta, así que la moneda nativa de las direcciones de depósito sale entera. Si el Safe no estaba desplegado, primero se despliega (otra transacción).</p>
</fieldset>
<label><input type="checkbox" id="linkok"> Entiendo que mandarlo todo a una dirección, y pagar el gas desde una cuenta mía, deja escrito en cadena que esos cobros son míos.</label>
<div class="row"><button id="moveall">Mover todo</button></div>
<div id="movelog"></div>
</div>

<div id="export" hidden>
<h2>Exportar</h2>
<p class="muted">Lista de direcciones (Safe y su dueño) para operar desde otra herramienta, por ejemplo la app de Safe una vez desplegado.</p>
<div class="row"><label><input type="checkbox" id="withkeys"> Incluir las claves privadas de los dueños (quien tenga el fichero puede gastar)</label><button id="exportbtn">Descargar CSV</button></div>
</div>

<details>
  <summary>Cómo hacerlo sin esta página (parámetros exactos)</summary>
  <ul>
    <li><b>Mensaje</b>: el de Fluidkey con PIN vacío para la dirección de la cuenta (<code>generateFluidkeyMessage({ pin: "", address })</code> del paquete <code>@fluidkey/stealth-account-kit</code>), firmado con <code>personal_sign</code>.</li>
    <li><b>Claves</b>: <code>generateKeysFromSignature</code> (keccak de r y de s). Si la firma no reproduce tu capa, prueba con la otra forma de s (n − s).</li>
    <li><b>Dirección de cada cobro</b> (nonce 0, 1, 2…): <code>extractViewingPrivateKeyNode</code>(nodo 0) → <code>generateEphemeralPrivateKey</code>(chainId 0) → <code>generateStealthAddresses</code> → dueño EOA; su clave con <code>generateStealthPrivateKey</code>.</li>
    <li><b>Safe</b>: NO es el de Fluidkey. Safe 1.4.1, un dueño, umbral 1, con el módulo ERC-4337 (entryPoint 0.7) tal como lo crea <code>toSafeSmartAccount</code> de permissionless, <code>saltNonce</code> 0; factoría <code>0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67</code>. Misma dirección en todas las redes EVM.</li>
    <li><b>WalletConnect</b>: necesita un Project ID (público, gratis en dashboard.reown.com). Si la página no trae uno, lo pide.</li>
    <li><b>Sacar</b>: desplegar con la factoría (<code>createProxyWithNonce</code>) si no lo está y <code>execTransaction</code> firmado por el dueño (EIP-712 SafeTx, gasPrice 0).</li>
  </ul>
</details>
<script>${js}</script>
</body>
</html>
`;

mkdirSync(resolve(root, "client/public"), { recursive: true });
writeFileSync(resolve(root, "client/public/rescate.html"), html);
if (process.env.RESCUE_METAFILE) writeFileSync(process.env.RESCUE_METAFILE, JSON.stringify(result.metafile));
console.log(`[rescate] client/public/rescate.html (${(html.length / 1024).toFixed(0)} KB)`);
