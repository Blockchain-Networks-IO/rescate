# Rescate de las direcciones de depósito de Mucho

Una herramienta para sacar el dinero de tus **direcciones de depósito** de
Mucho **sin depender de Mucho**: ni de su web, ni de sus servidores. Es un
único fichero, `rescate.html`, que se abre en tu ordenador y habla
directamente con la cadena de bloques.

- **Abrirla en el navegador:** https://blockchain-networks-io.github.io/rescate/
- **Descargarla:** `rescate.html` de la [última versión](https://github.com/Blockchain-Networks-IO/rescate/releases/latest).
  Guárdala junto a la copia de tu frase de recuperación.

Versión del 2026-11-04 (código 7c2845830271).
SHA-256 de `rescate.html`: `96a187e7b95d92cc4032647942611f7e01935e400952758954d06deadc76deb1`

## ¿Cuándo la necesitas?

- Dejas el Club o la Membresía y ya no tienes las direcciones de depósito en el monedero.
- Elegiste «Solo tu llave» y perdiste todas tus llaves: Mucho ya no puede firmar por ti.
- Mucho deja de funcionar.

Mientras puedas entrar y firmar en el monedero, no la necesitas. Tus cuentas,
tu bitcoin y tu Solana no hacen falta rescatarlos: se recuperan importando tu
frase en cualquier otra billetera.

## Cómo se usa

1. **Ten tu cuenta en otra billetera.** Importa tu frase de recuperación en
   una billetera como Rabby o MetaMask (la Cuenta 1 de Mucho es la primera que
   te enseñan; la Cuenta 2, la segunda…), o conecta el Ledger o el OneKey que
   usabas en Mucho. La frase se escribe en esa billetera, **nunca en una web**.
2. **Abre `rescate.html` y conecta esa billetera.** Si es una extensión y no
   aparece al abrir el fichero desde tu ordenador, dale permiso para ficheros
   locales: en `chrome://extensions` (o `brave://extensions`,
   `edge://extensions`), «Detalles» de la extensión y activa «Permitir el
   acceso a las URL de archivo»; luego recarga. O usa WalletConnect con la
   billetera del móvil.
3. **Firma el mensaje.** Es la firma de un texto, no una transacción: no mueve
   nada ni cuesta gas.
4. **Busca.** La herramienta calcula tus direcciones de depósito y mira su
   saldo en cada red. Si sabes que tenías algo y no sale, sube «cuántas
   direcciones mirar» o añade el contrato del token.
5. **Muévelo.** Pon la dirección de destino y pulsa «Mover todo». El gas lo
   paga la billetera conectada, así que necesita un poco de la moneda de cada
   red. Si algo falla a medias, vuelve a pulsar: lo ya hecho no se repite.

Nadie de Mucho te va a pedir tu frase. Si una página te la pide para
«rescatar» o «verificar» tus fondos, es un robo.

## Tu saldo confidencial

El saldo confidencial no vive en Mucho, sino en NEAR Intents. Importa tu frase
en una billetera como Rabby y conéctala en [near.com](https://near.com): ahí
está tu saldo confidencial, esperándote.

## Comprobar que el fichero es este

Antes de usar una copia que no hayas descargado tú de aquí, comprueba su huella:

```
sha256sum rescate.html          # Linux
shasum -a 256 rescate.html      # macOS
certutil -hashfile rescate.html SHA256   # Windows
```

Tiene que dar lo mismo que `SHA256SUMS` de esa versión.

## Qué hay en este repositorio

- `rescate.html` / `index.html`: la herramienta (el mismo fichero).
- `fuente/`: nuestro código que entra en ella, sin minificar, para que se
  pueda leer qué hace. Usa los mismos módulos que el monedero de Mucho.
- `DEPENDENCIAS.txt`: los paquetes de npm que entran, con su versión exacta.

Todo se calcula en tu navegador: lo único que sale son las lecturas y las
transacciones al RPC público de cada red, que puedes cambiar por el tuyo. Los
parámetros exactos para hacerlo sin la herramienta están al final de la propia
página («Cómo hacerlo sin esta página»).

Este repositorio se actualiza solo desde el monedero de Mucho cada vez que
cambia la herramienta.
