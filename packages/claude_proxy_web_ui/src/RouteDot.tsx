export interface RouteDotAppearance {
  letter?: string;
  colour: string;
}

/** The coloured dot with the route letter, the same mark that the menu bar app shows. */
export function RouteDot({ routeAppearance, size = 18 }: { routeAppearance: RouteDotAppearance; size?: number }) {
  return (
    <span
      className="route-dot"
      aria-hidden="true"
      style={{
        width: size,
        height: size,
        fontSize: Math.round(size * 0.55),
        background: routeAppearance.colour,
        color: readableTextColour(routeAppearance.colour),
      }}
    >
      {routeAppearance.letter}
    </span>
  );
}

/** Picks black or white text for a background colour, from its relative luminance. */
function readableTextColour(backgroundColour: string): string {
  const hexMatch = /^#?([0-9a-f]{6})$/i.exec(backgroundColour.trim());
  if (!hexMatch) return '#000000';
  const channelValues = [0, 2, 4].map((channelOffset) => parseInt(hexMatch[1]!.slice(channelOffset, channelOffset + 2), 16) / 255);
  const [red, green, blue] = channelValues.map((channelValue) =>
    channelValue <= 0.03928 ? channelValue / 12.92 : ((channelValue + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  const relativeLuminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  return relativeLuminance > 0.4 ? '#000000' : '#ffffff';
}
