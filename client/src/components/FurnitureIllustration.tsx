/**
 * Original line-art illustration for the login page's brand panel - an
 * abstract armchair/lamp/side-table grouping in the company's own green,
 * not a photo of any real product (we don't have licensed product photography).
 */
export function FurnitureIllustration() {
  return (
    <svg viewBox="0 0 420 420" width="100%" height="100%" role="img" aria-labelledby="furnitureIllustrationTitle">
      <title id="furnitureIllustrationTitle">Illustration of an armchair, lamp and side table</title>
      <defs>
        <linearGradient id="glow" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#ffffff" stopOpacity="0.16" />
          <stop offset="100%" stopColor="#ffffff" stopOpacity="0.02" />
        </linearGradient>
      </defs>

      {/* Rug */}
      <ellipse cx="210" cy="345" rx="150" ry="18" fill="#ffffff" opacity="0.08" />

      {/* Floor lamp */}
      <g opacity="0.95">
        <rect x="318" y="120" width="4" height="190" rx="2" fill="#ffffff" opacity="0.55" />
        <circle cx="320" cy="308" r="14" fill="none" stroke="#ffffff" strokeOpacity="0.55" strokeWidth="3" />
        <path
          d="M292 118 Q320 90 348 118 L340 138 Q320 122 300 138 Z"
          fill="url(#glow)"
          stroke="#ffffff"
          strokeOpacity="0.7"
          strokeWidth="2.5"
        />
      </g>

      {/* Side table with plant */}
      <g opacity="0.95">
        <rect x="55" y="245" width="70" height="10" rx="3" fill="#ffffff" opacity="0.6" />
        <rect x="62" y="255" width="4" height="55" fill="#ffffff" opacity="0.5" />
        <rect x="114" y="255" width="4" height="55" fill="#ffffff" opacity="0.5" />
        <path d="M78 245 Q90 205 90 245" fill="none" stroke="#ffffff" strokeOpacity="0.65" strokeWidth="2.5" />
        <path d="M90 245 Q100 210 106 245" fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="2.5" />
        <path d="M90 245 Q78 215 70 240" fill="none" stroke="#ffffff" strokeOpacity="0.5" strokeWidth="2.5" />
        <path d="M76 236 L104 236 L100 245 L80 245 Z" fill="#ffffff" opacity="0.5" />
      </g>

      {/* Armchair */}
      <g>
        <path
          d="M150 340 L150 250 Q150 224 176 224 L264 224 Q290 224 290 250 L290 340 Z"
          fill="url(#glow)"
          stroke="#ffffff"
          strokeOpacity="0.85"
          strokeWidth="3"
        />
        <path
          d="M150 300 L150 250 Q150 236 164 236 L176 236 L176 300 Z"
          fill="#ffffff"
          opacity="0.14"
          stroke="#ffffff"
          strokeOpacity="0.65"
          strokeWidth="2.5"
        />
        <path
          d="M290 300 L290 250 Q290 236 276 236 L264 236 L264 300 Z"
          fill="#ffffff"
          opacity="0.14"
          stroke="#ffffff"
          strokeOpacity="0.65"
          strokeWidth="2.5"
        />
        <rect x="176" y="270" width="88" height="16" rx="8" fill="#ffffff" opacity="0.18" />
        <line x1="164" y1="340" x2="158" y2="365" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round" />
        <line x1="276" y1="340" x2="282" y2="365" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round" />
        <line x1="176" y1="340" x2="172" y2="365" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round" />
        <line x1="264" y1="340" x2="268" y2="365" stroke="#ffffff" strokeOpacity="0.6" strokeWidth="4" strokeLinecap="round" />
      </g>

      {/* Decorative dots */}
      <circle cx="60" cy="110" r="4" fill="#ffffff" opacity="0.4" />
      <circle cx="90" cy="130" r="3" fill="#ffffff" opacity="0.3" />
      <circle cx="350" cy="70" r="4" fill="#ffffff" opacity="0.35" />
    </svg>
  );
}
