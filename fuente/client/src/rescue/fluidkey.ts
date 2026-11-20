/**
 * Modo FLUIDKEY de la herramienta de rescate (`rescate.html`,
 * `docs/RESCATE-DIRECCIONES-DE-DEPOSITO.md` § «Cuentas de Fluidkey»).
 *
 * Por qué existe: el 19-11-2026 Fluidkey sufrió un incidente de seguridad y
 * apagó su web y sus APIs. Sus usuarios —muchos socios, y el dueño— tienen el
 * dinero en Safes que solo se mueven desde esa web. Con esta herramienta lo
 * sacan sin ella y sin esperar a su informe.
 *
 * Es la misma matemática que nuestras direcciones de depósito (el kit abierto
 * de Fluidkey), con tres diferencias:
 *  1. El mensaje lleva el PIN que el usuario eligió en Fluidkey
 *     (`generateFluidkeyMessage({ pin, address })`).
 *  2. Sus Safes son Safe 1.3.0 SIN módulo 4337, y su dirección depende de la
 *     CONFIGURACIÓN con la que se crearon (auto-earn y sus versiones), así que
 *     cada nonce da un Safe por configuración (`FLUIDKEY_PROFILES`).
 *  3. Con auto-earn el dinero no está en USDC sino en participaciones de una
 *     bóveda ERC-4626: se sacan con `redeem` hacia el destino.
 *
 * Lo de este fichero no toca el DOM ni la red: lo usan `standalone.ts` y los
 * tests.
 */
import {
  concat,
  encodeFunctionData,
  getAddress,
  getContractAddress,
  keccak256,
  pad,
  parseAbi,
  toHex,
  zeroAddress,
  type Address,
  type Hex,
} from "viem";
import type { ChainKey } from "@shared/wallet/chains";
import { buildStealthKeygenMessage, deriveStealthAccount, type StealthMasterKeys } from "@/lib/web3/stealth/derive";
import { FLUIDKEY_PROFILES, type FluidkeyProfile } from "./fluidkeyProfiles";
import type { RescueAsset, RescueNote } from "./core";

/**
 * Contratos de Safe 1.3.0 en sus direcciones CANÓNICAS (las «default» de
 * `@safe-global/safe-deployments` 1.29.0, la versión que usa el kit), las
 * mismas en todas las redes EVM. Fluidkey crea sus Safes con
 * `useDefaultAddress: true`; por eso un Safe de Fluidkey tiene la misma
 * dirección en Base, Arbitrum, Ethereum…
 */
export const FLUIDKEY_SAFE_1_3_0 = {
  proxyFactory: "0xa6B71E26C5e0845f74c812102Ca7114b6a896AB2",
  singleton: "0xd9Db270c1B5E3Bd161E8c8503c55cEABeE709552",
  fallbackHandler: "0xf48f2B2d2a534e402487b3ee7C18c33Aec0Fe5e4",
} as const satisfies Record<string, Address>;

/**
 * `proxyCreationCode()` de esa factoría (GnosisSafeProxy 1.3.0). Es el mismo
 * que trae SARA (`SAFE_PROXY_BYTECODE`); el test lo comprueba contra Safes
 * reales de cada configuración.
 */
export const SAFE_PROXY_CREATION_CODE_1_3_0: Hex =
  "0x608060405234801561001057600080fd5b506040516101e63803806101e68339818101604052602081101561003357600080fd5b8101908080519060200190929190505050600073ffffffffffffffffffffffffffffffffffffffff168173ffffffffffffffffffffffffffffffffffffffff1614156100ca576040517f08c379a00000000000000000000000000000000000000000000000000000000081526004018080602001828103825260228152602001806101c46022913960400191505060405180910390fd5b806000806101000a81548173ffffffffffffffffffffffffffffffffffffffff021916908373ffffffffffffffffffffffffffffffffffffffff1602179055505060ab806101196000396000f3fe608060405273ffffffffffffffffffffffffffffffffffffffff600054167fa619486e0000000000000000000000000000000000000000000000000000000060003514156050578060005260206000f35b3660008037600080366000845af43d6000803e60008114156070573d6000fd5b3d6000f3fea2646970667358221220d1429297349653a4918076d650332de1a1068c5f3e07c5c82360c277770b955264736f6c63430007060033496e76616c69642073696e676c65746f6e20616464726573732070726f7669646564";

const SETUP_ABI = parseAbi([
  "function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)",
]);
const FACTORY_ABI = parseAbi([
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
]);

/** El mensaje que se firma en Fluidkey para sacar las claves (con el PIN). */
export function fluidkeyKeygenMessage(address: Address, pin: string): string {
  return buildStealthKeygenMessage({ address, pin });
}

/** El `setup` del Safe de un dueño con una configuración (igual que el kit). */
export function fluidkeyInitializer(owner: Address, profile: FluidkeyProfile): Hex {
  return encodeFunctionData({
    abi: SETUP_ABI,
    functionName: "setup",
    args: [
      [owner],
      1n,
      profile.initializer?.to ?? zeroAddress,
      profile.initializer?.data ?? "0x",
      FLUIDKEY_SAFE_1_3_0.fallbackHandler,
      zeroAddress,
      0n,
      zeroAddress,
    ],
  });
}

/** Dirección del Safe (CREATE2 de la factoría, `saltNonce` 0). Sin red. */
export function fluidkeySafeAddress(owner: Address, profile: FluidkeyProfile): Address {
  const initializer = fluidkeyInitializer(owner, profile);
  return getContractAddress({
    opcode: "CREATE2",
    from: FLUIDKEY_SAFE_1_3_0.proxyFactory,
    salt: keccak256(concat([keccak256(initializer), pad(toHex(0n))])),
    bytecode: concat([SAFE_PROXY_CREATION_CODE_1_3_0, pad(FLUIDKEY_SAFE_1_3_0.singleton)]),
  });
}

/** La llamada que despliega el Safe (cualquier cuenta puede enviarla). */
export function fluidkeyDeployCall(owner: Address, profile: FluidkeyProfile): { to: Address; data: Hex } {
  return {
    to: FLUIDKEY_SAFE_1_3_0.proxyFactory,
    data: encodeFunctionData({
      abi: FACTORY_ABI,
      functionName: "createProxyWithNonce",
      args: [FLUIDKEY_SAFE_1_3_0.singleton, fluidkeyInitializer(owner, profile), 0n],
    }),
  };
}

export function fluidkeyProfile(id: string): FluidkeyProfile {
  const p = FLUIDKEY_PROFILES.find((x) => x.id === id);
  if (!p) throw new Error(`Configuración de Fluidkey desconocida: ${id}`);
  return p;
}

/**
 * Los Safes de los nonces `from..from+count-1`, uno por configuración. El `chainId`
 * de la derivación es 0 (el que usa Fluidkey: un mismo cobro vale en todas las
 * redes); se puede cambiar por si alguna cuenta antigua usó otro.
 */
export function fluidkeyNotes(
  keySets: StealthMasterKeys[],
  count: number,
  opts: { profiles?: FluidkeyProfile[]; derivationChainId?: number; from?: number } = {},
): RescueNote[] {
  const profiles = opts.profiles ?? FLUIDKEY_PROFILES;
  const out: RescueNote[] = [];
  for (let k = 0; k < keySets.length; k++) {
    const from = opts.from ?? 0;
    for (let n = from; n < from + count; n++) {
      const acc = deriveStealthAccount(keySets[k]!, { nonce: BigInt(n), chainId: opts.derivationChainId ?? 0 });
      for (const p of profiles) {
        out.push({
          keySet: k,
          nonce: n,
          owner: acc.address,
          ownerKey: acc.stealthPrivateKey,
          safe: fluidkeySafeAddress(acc.address, p),
          fluidkeyProfile: p.id,
        });
      }
    }
  }
  return out;
}

/**
 * Tokens que se miran además de los del catálogo del monedero (que solo trae
 * USDC). Símbolo y decimales COMPROBADOS en cadena el 20-11-2026.
 */
const FLUIDKEY_TOKENS: Partial<Record<ChainKey, Array<[string, Address, number]>>> = {
  base: [
    ["EURC", "0x60a3E35Cc302bFA44Cb288Bc5a4F316Fdb1adb42", 6],
    ["WETH", "0x4200000000000000000000000000000000000006", 18],
    ["cbBTC", "0xcbB7C0000aB88B473b1f5aFd9ef808440eed33Bf", 8],
    ["USDbC", "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA", 6],
    ["USDT", "0xfde4C96c8593536E31F229EA8f37b2ADa2699bb2", 6],
    ["DAI", "0x50c5725949A6F0c72E6C4a641F24049A917DB0Cb", 18],
  ],
  arbitrum: [
    ["USDT", "0xFd086bC7CD5C481DCC9C85ebE478A1C0b69FCbb9", 6],
    ["USDC.e", "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", 6],
    ["WETH", "0x82aF49447D8a07e3bd95BD0d56f35241523fBab1", 18],
    ["WBTC", "0x2f2a2543B76A4166549F7aaB2e75Bef0aefC5B0f", 8],
    ["DAI", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18],
  ],
  ethereum: [
    ["USDT", "0xdAC17F958D2ee523a2206206994597C13D831ec7", 6],
    ["EURC", "0x1aBaEA1f7C830bD89Acc67eC4af516284b1bC33c", 6],
    ["WETH", "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2", 18],
    ["WBTC", "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599", 8],
    ["DAI", "0x6B175474E89094C44Da98b954EedeAC495271d0F", 18],
  ],
  optimism: [
    ["USDT", "0x94b008aA00579c1307B0EF2c499aD98a8ce58e58", 6],
    ["USDC.e", "0x7F5c764cBc14f9669B88837ca1490cCa17c31607", 6],
    ["WETH", "0x4200000000000000000000000000000000000006", 18],
    ["DAI", "0xDA10009cBd5D07dd0CeCc66161FC93D7c9000da1", 18],
  ],
  polygon: [
    ["USDT", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F", 6],
    ["USDC.e", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", 6],
    ["WETH", "0x7ceB23fD6bC0adD59E62ac25578270cFf1b9f619", 18],
    ["DAI", "0x8f3Cf7ad23Cd3CaDbD9735AFf958023239c6A063", 18],
  ],
};

/**
 * Bóvedas ERC-4626 a las que el auto-earn de Fluidkey lleva el dinero. Salen
 * de las transacciones de sus módulos de auto-earn en cadena (20-11-2026):
 * participaciones acuñadas a Safes de Fluidkey. Comprobadas con `asset()`.
 * Solo Base: en las demás redes no se vio ninguna.
 */
const FLUIDKEY_VAULTS: Partial<Record<ChainKey, Array<[string, Address]>>> = {
  base: [
    ["Fluidkey USDC Yield by KPK", "0x7c29b2699a508831d444730cd34d99e0ad2d2624"],
    ["KPK USDC Yield", "0x392b3ccf36c8adb8094f45573346b457414cd752"],
    ["Gauntlet USDC Prime", "0x050ce30b927da55177a4914ec73480238bad56f0"],
    // Las dos de auto-earn v1.0 (están en su configuración).
    ["Gauntlet USDC Prime (v1.0)", "0xeE8F4eC5672F09119b96Ab6fB59C27E1b7e44b61"],
    ["Gauntlet EURC Core (v1.0)", "0x1c155be6bc51f2c37d472d4c2eba7a637806e122"],
    ["Gauntlet EURC Balanced", "0x94af495de1f56aa5576deb17986bdcee5dd9778d"],
    ["Steakhouse Prime USDC", "0xbeef0e0834849acc03f0089f01f4f1eeb06873c9"],
    ["infiniFi USDC Vault", "0xdeb0284d7120d3005cb06961cb1e651942ce765f"],
  ],
};

/**
 * Lo que se mira en una red en modo Fluidkey, ADEMÁS de lo de siempre
 * (`assetsFor`): sus tokens y sus bóvedas. Una bóveda va marcada `vault`: se
 * saca con `redeem` y llega el activo de debajo (USDC, EURC…).
 */
export function fluidkeyExtraAssets(chain: ChainKey): RescueAsset[] {
  const list: RescueAsset[] = [];
  for (const [symbol, token, decimals] of FLUIDKEY_TOKENS[chain] ?? []) {
    list.push({ chain, symbol, token: getAddress(token), decimals });
  }
  for (const [name, vault] of FLUIDKEY_VAULTS[chain] ?? []) {
    // Participaciones con 18 decimales (todas las de la lista; comprobado).
    list.push({ chain, symbol: name, token: getAddress(vault), decimals: 18, vault: true });
  }
  return list;
}

export { FLUIDKEY_PROFILES };
