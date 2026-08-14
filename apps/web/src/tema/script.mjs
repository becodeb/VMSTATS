/**
 * Script del tema, en JavaScript plano.
 *
 * Vive en su propio archivo `.mjs` —y no dentro de `tema.tsx`— porque lo tienen
 * que importar dos cosas muy distintas: el layout, que lo inyecta inline en el
 * `<head>`, y `astro.config.mjs`, que calcula su hash SHA-256 para el CSP.
 *
 * Si estuviera en el `.tsx` de React, la configuración de Astro tendría que
 * importar un módulo con JSX para leer una cadena de texto.
 *
 * Corre antes del primer pintado y no puede fallar nunca: si tira una
 * excepción, la página se queda sin tema. De ahí el try/catch mudo.
 */

export const CLAVE_TEMA = 'vmstats:tema'

export const SCRIPT_TEMA = `(function(){try{
var g=localStorage.getItem('${CLAVE_TEMA}');
var o=g==='oscuro'||(g!=='claro'&&matchMedia('(prefers-color-scheme: dark)').matches);
document.documentElement.classList.toggle('dark',o);
document.documentElement.style.colorScheme=o?'dark':'light';
}catch(e){}})()`
