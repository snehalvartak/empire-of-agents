interface AgentAvatarProps {
  name: string;
  color: string;
  size: number;
  status?: string;
}

function shade(hex: string, amount: number): string {
  const n = hex.replace('#', '');
  const r = parseInt(n.slice(0, 2), 16);
  const g = parseInt(n.slice(2, 4), 16);
  const b = parseInt(n.slice(4, 6), 16);
  const f = (c: number) =>
    Math.round(amount >= 0 ? c + (255 - c) * amount : c * (1 + amount))
      .toString(16)
      .padStart(2, '0');
  return `#${f(r)}${f(g)}${f(b)}`;
}

/** 3D-extruded villager token: thick beveled base, glossy top face, specular highlight. */
export function AgentAvatar({ name, color, size, status }: AgentAvatarProps) {
  const uid = `av${color.replace('#', '')}${size}${name.replace(/[^a-zA-Z0-9]/g, '')}`;
  const thinking = status === 'thinking';
  const acting = status === 'acting';
  const glow = thinking || acting ? 8 : 3;

  const dark = shade(color, -0.6);
  const darker = shade(color, -0.75);
  const light = shade(color, 0.45);

  return (
    <span className="relative inline-flex" style={{ width: size, height: size }}>
      {(thinking || acting) && (
        <span
          className={`absolute -inset-1 rounded-full ${thinking ? 'animate-ping' : 'animate-pulse'}`}
          style={{ backgroundColor: color, opacity: 0.35 }}
        />
      )}
      <svg width={size} height={size} viewBox="0 0 40 48" className="relative z-10">
        <defs>
          {/* glossy top face */}
          <radialGradient id={`${uid}-top`} cx="38%" cy="22%" r="95%">
            <stop offset="0%" stopColor={light} />
            <stop offset="35%" stopColor={color} />
            <stop offset="78%" stopColor={shade(color, -0.3)} />
            <stop offset="100%" stopColor={dark} />
          </radialGradient>
          {/* extrusion side faces */}
          <linearGradient id={`${uid}-side`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={shade(color, -0.15)} />
            <stop offset="100%" stopColor={darker} />
          </linearGradient>
          <linearGradient id={`${uid}-bevel`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="#ffffff" stopOpacity={0.9} />
            <stop offset="45%" stopColor="#ffffff" stopOpacity={0.1} />
            <stop offset="100%" stopColor="#000000" stopOpacity={0.55} />
          </linearGradient>
        </defs>

        {/* ground shadow */}
        <ellipse cx="20" cy="45.5" rx="12" ry="2.4" fill="#000" opacity={0.5} />

        {/* extruded body: lower copy shifted down for thickness */}
        <g style={{ filter: `drop-shadow(0 0 ${glow}px ${color}88)` }}>
          <path d="M20 10 L37 19.5 L37 34.5 L20 45 L3 34.5 L3 19.5 Z" fill={`url(#${uid}-side)`} />
          {/* side edge highlights */}
          <path d="M3 34.5 L20 45 L20 42 L3 31.5 Z" fill="#000" opacity={0.25} />
          <path d="M37 34.5 L20 45 L20 42 L37 31.5 Z" fill="#000" opacity={0.12} />
          {/* top face sitting on the extrusion */}
          <path
            d="M20 3 L37 12.5 L37 34.5 L20 44 L3 34.5 L3 12.5 Z"
            fill={`url(#${uid}-top)`}
            stroke={light}
            strokeOpacity={0.6}
            strokeWidth={1}
          />
          {/* beveled rim */}
          <path
            d="M20 4.6 L35.4 13.3 L35.4 33.7 L20 42.3 L4.6 33.7 L4.6 13.3 Z"
            fill="none"
            stroke={`url(#${uid}-bevel)`}
            strokeWidth={1.6}
          />
          {/* top sheen sweep */}
          <path d="M20 5.5 L34.5 13.6 L20 21 L5.5 13.6 Z" fill="#ffffff" opacity={0.22} />
          {/* specular highlight blob */}
          <ellipse cx="13.5" cy="14.5" rx="4.5" ry="2.6" fill="#ffffff" opacity={0.5} transform="rotate(-24 13.5 14.5)" />
          {/* inset floor ring around initial */}
          <ellipse cx="20" cy="30" rx="8.5" ry="5.2" fill="#000" opacity={0.18} />
          {/* initial */}
          <text
            x="20"
            y="33.5"
            textAnchor="middle"
            fontSize="15"
            fontWeight="800"
            fill="#fffdf5"
            style={{
              textShadow: '0 2px 3px rgba(0,0,0,0.85)',
              paintOrder: 'stroke',
              stroke: 'rgba(15,10,4,0.6)',
              strokeWidth: 2.5,
            }}
          >
            {name.slice(0, 1)}
          </text>
        </g>
      </svg>
    </span>
  );
}
