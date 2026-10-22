/* Shared data, icons and view switching for the design studies.
   Illustrative data only: nothing here talks to a wallet, an RPC or the network. */
(function () {
  "use strict";

  // Network marks copied from what the app already bundles (ConnectKit's inline
  // SVGs, the app's faceted Ethereum diamond and its HyperEVM / Robinhood monograms).
  const icon = body => `<g fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${body}</g>`;
  const sprite = `<svg width="0" height="0" style="position:absolute" aria-hidden="true" focusable="false"><defs>
<symbol id="c-1" viewBox="0 0 32 32"><circle cx="16" cy="16" r="16" fill="#627EEA"/><g fill="#FFF"><path d="M16 4v8.87l7.5 3.35z" fill-opacity=".6"/><path d="M16 4 8.5 16.22 16 12.87z"/><path d="M16 21.97V28l7.5-10.38z" fill-opacity=".6"/><path d="M16 28v-6.03l-7.5-4.35z"/><path d="m16 20.57 7.5-4.35-7.5-3.35z" fill-opacity=".2"/><path d="m8.5 16.22 7.5 4.35v-7.7z" fill-opacity=".6"/></g></symbol>
<symbol id="c-10" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#FF0420"/><rect x="5.5" y="5.5" width="33" height="33" rx="16.5" fill="#FFF"/><path d="M38.5 22C38.5 12.8924 31.0968 5.52416 22 5.5C12.879 5.5 5.5 12.8924 5.5 22C5.5 31.1076 12.9032 38.4758 22 38.5C31.121 38.5 38.5 31.1076 38.5 22ZM21.9758 30.2379V37.7994C15.3226 37.7994 9.92742 32.4122 9.92742 25.7687C9.92742 19.1252 15.3226 13.7379 21.9758 13.7379V6.17643C28.629 6.17643 34.0242 11.5637 34.0242 18.2072C34.0242 24.8507 28.629 30.2379 21.9758 30.2379Z" fill="#FF0420"/><path d="M22.0239 16.3223H21.9271C20.6691 18.8347 18.8062 20.6949 16.29 21.9511V22.0477C18.8062 23.304 20.6691 25.1641 21.9271 27.6766H22.0239C23.282 25.1641 25.1449 23.304 27.661 22.0477V21.9511C25.1449 20.6949 23.282 18.8347 22.0239 16.3223Z" fill="#FF0420"/></symbol>
<symbol id="c-56" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#16181A"/><g fill="#F3BA2F"><path d="M16.0445 19.6063L21.8705 13.7805L27.6996 19.6093L31.0896 16.2193L21.8705 7L12.6545 16.2163L16.0445 19.6063Z"/><path d="M13.6505 21.9995L10.2606 18.6096L6.87046 21.9997L10.2604 25.3896L13.6505 21.9995Z"/><path d="M16.0445 24.3937L21.8705 30.2195L27.6994 24.3909L31.0913 27.779L31.0896 27.7809L21.8705 37L12.6542 27.7839L12.6495 27.7792L16.0445 24.3937Z"/><path d="M33.4808 25.3911L36.8709 22.001L33.481 18.6111L30.0909 22.0012L33.4808 25.3911Z"/><path d="M25.3091 21.9982H25.3105L21.8705 18.5582L19.3283 21.1004H19.3281L19.0362 21.3926L18.4336 21.9951L18.4289 21.9999L18.4336 22.0048L21.8705 25.4418L25.3105 22.0018L25.3122 21.9999L25.3091 21.9982Z"/></g></symbol>
<symbol id="c-100" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#009CB4"/><path fill-rule="evenodd" clip-rule="evenodd" fill="#FFF" d="M12.3439 11.8664C17.9374 6.53462 26.7953 6.74397 32.1271 12.3374C32.4738 12.7038 32.8075 13.0832 33.1084 13.4823L22 24.5972L10.8916 13.4823C11.1991 13.0832 11.5262 12.7038 11.8729 12.3374C12.0234 12.1804 12.1804 12.0234 12.3439 11.8664ZM30.6094 13.3972C28.3196 11.0944 25.271 9.83182 22 9.83182C18.729 9.83182 15.6804 11.0944 13.3907 13.3972L22 22.0066L30.6094 13.3972ZM33.9785 14.7446L31.7215 17.0016C33.5402 19.1801 33.2523 22.425 31.0738 24.2437C29.1636 25.84 26.3897 25.84 24.4794 24.2437L22 26.7231L19.5271 24.2502C17.3486 26.0689 14.1037 25.7811 12.285 23.6026C10.6888 21.6923 10.6888 18.9185 12.285 17.0082L11.1271 15.8502L10.028 14.7446C8.7 16.9297 8 19.4418 8 21.9998C8 29.7325 14.2673 35.9998 22 35.9998C29.7327 35.9998 36 29.7325 36 21.9998C36.0065 19.4418 35.3 16.9297 33.9785 14.7446ZM30.6486 18.0747C31.1392 18.7093 31.4075 19.4943 31.4075 20.299C31.4075 21.1037 31.1392 21.8887 30.6486 22.5233C29.4187 24.113 27.1355 24.4074 25.5458 23.1775L30.6486 18.0747ZM18.4542 23.1839C17.8196 23.6745 17.0346 23.9427 16.2299 23.9427C15.4252 23.9427 14.6467 23.6745 14.0056 23.1904C12.4159 21.9605 12.1215 19.6708 13.3514 18.0811L18.4542 23.1839Z"/></symbol>
<symbol id="c-137" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#6F41D8"/><path fill="#FFF" d="M29.0015 17.4529C28.4941 17.1572 27.8355 17.1572 27.2773 17.4529L23.3186 19.7271L20.6305 21.2094L16.6719 23.4822C16.1645 23.7792 15.5059 23.7792 14.9476 23.4822L11.8016 21.703C11.2943 21.4074 10.9395 20.8642 10.9395 20.2702V16.7612C10.9395 16.1686 11.2434 15.6255 11.8016 15.3285L14.8954 13.5988C15.4041 13.3018 16.0641 13.3018 16.6224 13.5988L19.7161 15.3285C20.2249 15.6255 20.5796 16.1686 20.5796 16.7612V19.0355L23.2678 17.5024V15.2295C23.2707 14.9343 23.1917 14.6441 23.0395 14.3911C22.8873 14.1381 22.6679 13.9324 22.4056 13.7968L16.6719 10.5353C16.1645 10.2382 15.5059 10.2382 14.9476 10.5353L9.11214 13.7968C8.84992 13.9324 8.63049 14.1381 8.47828 14.3911C8.32607 14.6441 8.24705 14.9343 8.25002 15.2295V21.802C8.25002 22.396 8.55389 22.9391 9.11214 23.2361L14.9476 26.4976C15.455 26.7932 16.115 26.7932 16.6719 26.4976L20.6305 24.2729L23.3186 22.7411L27.2773 20.5177C27.7846 20.2207 28.4433 20.2207 29.0015 20.5177L32.0966 22.2475C32.6054 22.5431 32.9588 23.0863 32.9588 23.6803V27.1893C32.9588 27.7819 32.6563 28.325 32.0966 28.622L29.0029 30.4013C28.4941 30.6983 27.8341 30.6983 27.2773 30.4013L24.1821 28.6715C23.6734 28.3745 23.3186 27.8314 23.3186 27.2387V24.9645L20.6305 26.4976V28.7705C20.6305 29.3631 20.9344 29.9076 21.4926 30.2032L27.3281 33.4647C27.8355 33.7617 28.4941 33.7617 29.0524 33.4647L34.8879 30.2032C35.3953 29.9076 35.75 29.3645 35.75 28.7705V22.198C35.753 21.9028 35.674 21.6126 35.5218 21.3596C35.3695 21.1066 35.1501 20.9009 34.8879 20.7653L29.0029 17.4529H29.0015Z"/></symbol>
<symbol id="c-999" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#0F3933"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" font-family="Arial, sans-serif" fill="#97FCE4">H</text></symbol>
<symbol id="c-4663" viewBox="0 0 24 24"><circle cx="12" cy="12" r="12" fill="#1E342D"/><text x="12" y="16.5" text-anchor="middle" font-size="13" font-weight="700" font-family="Arial, sans-serif" fill="#CCFF00">R</text></symbol>
<symbol id="c-8453" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#0052FF"/><path fill="#FFF" d="M21.9756 36C29.721 36 36 29.732 36 22C36 14.268 29.721 8 21.9756 8C14.6271 8 8.59871 13.6419 8 20.8232H26.5371V23.1768H8C8.59871 30.3581 14.6271 36 21.9756 36Z"/></symbol>
<symbol id="c-42161" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#2C364F"/><path fill="#2D374B" d="M25.7948 20.5826L28.2683 16.3854L34.9355 26.7696L34.9386 28.7625L34.9168 15.0491C34.9011 14.7137 34.7231 14.407 34.4391 14.2261L22.4357 7.32182C22.1551 7.1838 21.7989 7.18546 21.5187 7.32618C21.4807 7.34524 21.4453 7.36576 21.4113 7.38835L21.3694 7.41467L9.71816 14.1664L9.67298 14.1871C9.61474 14.2137 9.55609 14.2479 9.50076 14.2872C9.27983 14.4456 9.1331 14.68 9.08564 14.9425C9.07859 14.9823 9.0732 15.023 9.07092 15.064L9.08916 26.239L15.2994 16.6138C16.0811 15.3376 17.7847 14.9262 19.3662 14.9488L21.2221 14.9977L10.2862 32.5356L11.5753 33.2778L22.6422 15.0155L27.5338 14.9977L16.4956 33.7209L21.0955 36.3668L21.6451 36.6827C21.8776 36.7772 22.1516 36.7819 22.386 36.6972L34.5581 29.6433L32.2309 30.9918L25.7948 20.5826ZM26.7384 34.175L22.0925 26.8829L24.9287 22.0702L31.0303 31.6876L26.7384 34.175Z"/><path fill="#28A0F0" d="M22.0924 26.8832L26.7385 34.1751L31.0302 31.6879L24.9286 22.0705L22.0924 26.8832Z"/><path fill="#28A0F0" d="M34.9387 28.7627L34.9356 26.7698L28.2684 16.3856L25.7949 20.5828L32.2312 30.992L34.5584 29.6435C34.7866 29.4582 34.9248 29.1861 34.9393 28.8926L34.9387 28.7627Z"/><path fill="#FFF" d="M7 30.642L10.2863 32.5356L21.2222 14.9976L19.3663 14.9487C17.785 14.9263 16.0814 15.3375 15.2995 16.6137L9.08927 26.239L7 29.449V30.642V30.642Z"/><path fill="#FFF" d="M27.534 14.9977L22.6423 15.0155L11.5754 33.2778L15.4437 35.5049L16.4955 33.7209L27.534 14.9977Z"/><path fill="#96BEDC" d="M37 14.9723C36.9592 13.9493 36.4052 13.013 35.5377 12.4677L23.377 5.47434C22.5187 5.04223 21.4466 5.04161 20.5868 5.47414C20.4852 5.52533 8.76078 12.3251 8.76078 12.3251C8.5985 12.4029 8.44224 12.4955 8.2953 12.6008C7.52081 13.156 7.0487 14.0186 7 14.9661V29.4492L9.08927 26.2392L9.07103 15.0639C9.07352 15.0231 9.0787 14.9827 9.08575 14.9431C9.133 14.6801 9.27994 14.4457 9.50086 14.2872C9.5562 14.2478 21.4806 7.34517 21.5186 7.32611C21.799 7.18538 22.155 7.18373 22.4356 7.32175L34.439 14.226C34.723 14.4069 34.901 14.7137 34.9167 15.049V28.8921C34.9022 29.1856 34.7862 29.4577 34.558 29.643L32.2308 30.9916L31.03 31.6875L26.7383 34.1747L22.3859 36.6969C22.1515 36.7817 21.8773 36.7769 21.645 36.6824L16.4955 33.7206L15.4435 35.5046L20.0713 38.169C20.2243 38.256 20.3607 38.3331 20.4726 38.3961C20.6458 38.4933 20.764 38.5582 20.8056 38.5785C21.1345 38.7383 21.6077 38.8311 22.0342 38.8311C22.4251 38.8311 22.8064 38.7594 23.1672 38.6181L35.8092 31.2971C36.5347 30.7348 36.9617 29.8869 37 28.9686V14.9723Z"/></symbol>
<symbol id="c-43114" viewBox="0 0 44 44"><circle cx="22" cy="22" r="22" fill="#E84142"/><path fill="#FFF" d="M11.0188 32.1528H15.4825C16.5334 32.1528 17.0589 32.1528 17.5278 32.023C18.042 31.8701 18.511 31.5991 18.9009 31.2261C19.2589 30.885 19.5173 30.4328 20.0269 29.5409L20.0272 29.5404L20.0422 29.5142L25.8314 19.2804C26.3456 18.3821 26.5999 17.93 26.7129 17.4554C26.8372 16.9412 26.8372 16.3988 26.7129 15.8847C26.6007 15.4136 26.3439 14.9648 25.8373 14.0798L25.8258 14.0597L23.56 10.1045C23.0911 9.27958 22.8538 8.86711 22.5543 8.71456C22.2323 8.55071 21.848 8.55071 21.526 8.71456C21.2265 8.86711 20.9892 9.27958 20.5202 10.1045L9.49892 29.5311C9.03561 30.3447 8.80392 30.7517 8.82089 31.0849C8.84349 31.4466 9.02994 31.7743 9.33507 31.9721C9.61756 32.1528 10.0809 32.1528 11.0188 32.1528Z"/><path fill="#FFF" d="M33.1506 32.1528H26.7547C25.8111 32.1528 25.3365 32.1528 25.0596 31.9721C24.7545 31.7743 24.5681 31.4411 24.5455 31.0794C24.5286 30.7486 24.7621 30.3456 25.2294 29.539L25.2295 29.5388L25.2404 29.5199L28.4328 24.0392C28.9018 23.2313 29.1391 22.8301 29.4329 22.6776C29.7548 22.5137 30.1336 22.5137 30.4555 22.6776C30.7472 22.8261 30.9744 23.2102 31.4241 23.9708L31.4248 23.9719L31.4613 24.0336L34.665 29.5143L34.7113 29.5939C35.1554 30.3603 35.382 30.7514 35.3657 31.0739C35.3486 31.4353 35.1566 31.7688 34.8515 31.9666C34.5689 32.1528 34.0942 32.1528 33.1506 32.1528Z"/></symbol>
<symbol id="i-check" viewBox="0 0 16 16"><path d="M3.5 8.4l2.9 2.9 6.1-6.6" fill="none" stroke="currentColor" stroke-width="2.1" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-chev" viewBox="0 0 16 16"><path d="M4.5 6.2 8 9.7l3.5-3.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></symbol>
<symbol id="i-wallet" viewBox="0 0 24 24">${icon('<path d="M4 6V5a2 2 0 0 1 2-2h12v4M4 7h16v14H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2Z"/><path d="M20 12h-6v5h6M16 14.5h1"/>')}</symbol>
<symbol id="i-safe" viewBox="0 0 24 24">${icon('<rect x="3" y="3" width="18" height="18" rx="3"/><circle cx="12" cy="12" r="4"/><path d="M12 6v3m0 6v3m-6-6h3m6 0h3"/>')}</symbol>
<symbol id="i-card" viewBox="0 0 24 24">${icon('<rect x="2" y="5" width="20" height="14" rx="3"/><path d="M2 10h20M6 15h4"/>')}</symbol>
<symbol id="i-key" viewBox="0 0 24 24">${icon('<circle cx="8" cy="15" r="4"/><path d="m10.9 12.1 8.6-8.6M16.5 6.5l2.5 2.5M14.5 8.5l1.8 1.8"/>')}</symbol>
<symbol id="i-code" viewBox="0 0 24 24">${icon('<path d="m8 7-5 5 5 5M16 7l5 5-5 5M13.5 4l-3 16"/>')}</symbol>
<symbol id="i-laptop" viewBox="0 0 24 24">${icon('<rect x="4" y="5" width="16" height="11" rx="1.5"/><path d="M2 19h20"/>')}</symbol>
<symbol id="i-eye-off" viewBox="0 0 24 24">${icon('<path d="M3 3l18 18M10.6 6.1A9.8 9.8 0 0 1 12 6c5 0 9 6 9 6a17 17 0 0 1-3 3.5M6.6 6.6C4.1 8.2 3 12 3 12s4 6 9 6c1.6 0 3-.4 4.3-1.1"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>')}</symbol>
<symbol id="i-user-off" viewBox="0 0 24 24">${icon('<circle cx="12" cy="8" r="4"/><path d="M4 21c1-4 4.5-6 8-6s7 2 8 6M3 3l18 18"/>')}</symbol>
<symbol id="i-globe" viewBox="0 0 24 24">${icon('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18"/>')}</symbol>
<symbol id="i-sign" viewBox="0 0 24 24">${icon('<path d="M4 21h16M6 17l9.5-9.5a2.1 2.1 0 0 1 3 3L9 20H6z"/>')}</symbol>
<symbol id="i-search" viewBox="0 0 24 24">${icon('<circle cx="11" cy="11" r="6.5"/><path d="m16 16 4.5 4.5"/>')}</symbol>
<symbol id="i-target" viewBox="0 0 24 24">${icon('<circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>')}</symbol>
<symbol id="i-send" viewBox="0 0 24 24">${icon('<path d="M4 12h12M12 6l6 6-6 6"/><path d="M20 4v16"/>')}</symbol>
<symbol id="i-return" viewBox="0 0 24 24">${icon('<path d="M9 7 4 12l5 5M4 12h11a5 5 0 0 0 0-10h-2"/>')}</symbol>
</defs></svg>`;
  document.body.insertAdjacentHTML("afterbegin", sprite);

  const N = (id, name, checked, assets) => ({ id, name, checked, assets });
  const A = (sym, name, bal, kind) => ({ sym, name, bal, kind });
  const NETWORKS = [
    N(1, "Ethereum", 312, [A("ETH", "Ether", "0,0634"), A("USDC", "USD Coin", "300,00"), A("stETH", "Lido Staked Ether", "0,2100")]),
    N(10, "Optimism", 118, [A("ETH", "Ether", "0,0089"), A("OP", "Optimism", "33,75")]),
    N(56, "BNB Chain", 164, []),
    N(100, "Gnosis", 241, [A("xDAI", "xDAI", "412,58"), A("EURe", "Monerium EUR", "1.250,00"), A("USDC.e", "USDC (bridged)", "860,12"),
      A("sDAI", "Savings xDAI", "3.104,77", "invest"), A("GNO", "Gnosis", "2,41"), A("WETH", "Wrapped Ether", "0,3820"),
      A("wstETH", "Wrapped stETH", "0,1504"), A("BRLA", "BRLA Token", "2.300,00"), A("COW", "CoW Protocol", "145,00"),
      A("EURe", "Monerium EUR · Safe do cartão", "184,30", "card")]),
    N(137, "Polygon", 287, [A("POL", "Polygon", "58,20"), A("USDC", "USD Coin", "512,40"), A("USDC.e", "USDC (bridged)", "75,00"),
      A("USDT", "Tether USD", "120,00"), A("WETH", "Wrapped Ether", "0,0910"), A("WBTC", "Wrapped BTC", "0,00412"),
      A("MaticX", "Stader MaticX", "40,11", "invest"), A("Cesta #1182", "Cesta Picnic", "1 NFT", "basket")]),
    N(999, "HyperEVM", 36, [A("HYPE", "Hyperliquid", "4,82")]),
    N(4663, "Robinhood", 12, []),
    N(8453, "Base", 196, [A("ETH", "Ether", "0,0215"), A("USDC", "USD Coin", "640,00"), A("cbBTC", "Coinbase Wrapped BTC", "0,00310"),
      A("MAMO", "Estratégia MAMO · USDC", "250,00", "invest"), A("AERO", "Aerodrome", "18,40")]),
    N(42161, "Arbitrum", 205, [A("ETH", "Ether", "0,0128"), A("USDC", "USD Coin", "95,50"), A("ARB", "Arbitrum", "61,00"), A("GMX", "GMX", "1,20")]),
    N(43114, "Avalanche", 98, [A("AVAX", "Avalanche", "3,10")]),
  ];
  const KIND = { invest: "Investimento", card: "Cartão", basket: "Cesta antiga" };

  const PR = window.PR = {
    NETWORKS, KIND,
    SIGNER: "0xd80b…eA62",
    SAFE: "0xF7d9…159c",
    ASSETS: NETWORKS.reduce((n, net) => n + net.assets.length, 0),
    WITH_ASSETS: NETWORKS.filter(net => net.assets.length).length,
    CHECKED: NETWORKS.reduce((n, net) => n + net.checked, 0).toLocaleString("pt-BR"),
    chain: (id, size = 18) => `<svg class="cl" width="${size}" height="${size}" aria-hidden="true"><use href="#c-${id}"/></svg>`,
    icon: (name, size = 18) => `<svg class="ic" width="${size}" height="${size}" aria-hidden="true"><use href="#i-${name}"/></svg>`,
    count: n => n === 0 ? "sem saldo" : n === 1 ? "1 ativo" : `${n} ativos`,
    badge: kind => kind ? ` <span class="badge${kind === "card" ? " card" : ""}">${KIND[kind]}</span>` : "",
    byCount: () => [...NETWORKS].sort((a, b) => b.assets.length - a.assets.length),
    fill(selector, render) { document.querySelectorAll(selector).forEach(el => { el.innerHTML = typeof render === "function" ? render(el) : render; }); },

    // Secondary utilities, worded as in the app. Inert: the mock never reads or submits anything.
    cardForm: (cls = "") => `<details class="card-form ${cls}"><summary>Não encontrou o saldo do cartão?</summary>
      <p>Informe a Safe do cartão na Gnosis. O módulo v5 e o vínculo com a conta consultada serão verificados, e cada saldo aparecerá na lista de ativos.</p>
      <div class="card-form-row"><label class="field"><span>Endereço da Safe do cartão</span><input type="text" placeholder="0x…" spellcheck="false" autocomplete="off"></label>
      <button type="button" class="btn">Adicionar saldos à lista</button></div></details>`,
    coverage: (cls = "") => `<details class="${cls}"><summary>O que esta consulta cobre</summary>
      <p>A consulta cobre o saldo nativo, tokens do catálogo local, tokens que você adicionar, investimentos conhecidos e propriedade de cestas. Não é um inventário universal: ativos fora do catálogo, conteúdo interno das cestas e contas com outro endereço podem exigir inspeção adicional. Resultados parciais nunca significam saldo zero.</p></details>`,
    advanced: (cls = "") => `<details class="${cls}"><summary>Avançado: RPCs de consulta</summary>
      <p>Sem RPC próprio, as consultas usam RPCs públicos e podem alternar entre eles após confirmar a rede (chain ID). Um RPC informado aqui é usado sozinho, também para transações. As URLs não são salvas nem exportadas.</p></details>`,
  };

  // Landing ⇄ flow. The hash keeps each view linkable from the gallery (#inicio / #fluxo).
  const titles = { inicio: document.body.dataset.titleInicio, fluxo: document.body.dataset.titleFluxo };
  function show(initial) {
    const view = location.hash === "#fluxo" ? "fluxo" : "inicio";
    document.querySelectorAll("[data-view]").forEach(el => { el.hidden = el.dataset.view !== view; });
    document.documentElement.dataset.current = view;
    if (titles[view]) document.title = titles[view];
    if (!initial) {
      window.scrollTo(0, 0);
      const target = document.querySelector(`[data-view="${view}"] [data-focus]`);
      if (target) target.focus({ preventScroll: true });
    }
  }
  window.addEventListener("hashchange", () => show(false));
  show(true);
})();
