import { Text, View, type StyleProp, type ViewStyle } from 'react-native';

/**
 * The few icons the app needs, drawn with views so that no icon font or native module has to
 * be added: the app updates over the air only while its native parts stay the same.
 */
interface Props {
  color: string;
  size?: number;
}
const box = (size: number): ViewStyle => ({
  width: size,
  height: size,
  alignItems: 'center',
  justifyContent: 'center',
});
const line = 1.75;

/** A chevron pointing `to` that side, drawn as two sides of a turned square. */
export function Chevron({
  color,
  size = 22,
  to,
  style,
}: Props & { to: 'left' | 'right' | 'up' | 'down'; style?: StyleProp<ViewStyle> }) {
  const arm = size * 0.42;
  const turn = { left: '-45deg', up: '45deg', right: '135deg', down: '225deg' }[to];
  const shift = { left: arm * 0.2, right: -arm * 0.2, up: arm * 0.2, down: -arm * 0.2 }[to];
  return (
    <View style={[box(size), style]}>
      <View
        style={{
          width: arm,
          height: arm,
          borderLeftWidth: 2,
          borderTopWidth: 2,
          borderColor: color,
          transform: [
            to === 'left' || to === 'right' ? { translateX: shift } : { translateY: shift },
            { rotate: turn },
          ],
        }}
      />
    </View>
  );
}

export function SidebarIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      <View
        style={{
          width: size * 0.84,
          height: size * 0.76,
          borderWidth: line,
          borderColor: color,
          borderRadius: 4,
          flexDirection: 'row',
        }}
      >
        <View style={{ width: size * 0.26, borderRightWidth: line, borderColor: color }} />
      </View>
    </View>
  );
}

/** An open book: two pages, each with lines of text, meeting at the spine. */
export function BookIcon({ color, size = 22 }: Props) {
  const page = (side: 'left' | 'right') => (
    <View
      style={{
        width: size * 0.42,
        height: size * 0.7,
        borderWidth: line,
        borderColor: color,
        borderRadius: 2,
        [side === 'left' ? 'borderTopLeftRadius' : 'borderTopRightRadius']: size * 0.22,
        paddingTop: size * 0.18,
        paddingHorizontal: size * 0.07,
        gap: size * 0.09,
      }}
    >
      <View style={{ height: 1.25, backgroundColor: color, opacity: 0.8 }} />
      <View style={{ height: 1.25, backgroundColor: color, opacity: 0.8 }} />
    </View>
  );
  return (
    <View style={[box(size), { flexDirection: 'row', gap: 1 }]}>
      {page('left')}
      {page('right')}
    </View>
  );
}

export function PencilIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      <View style={{ transform: [{ rotate: '45deg' }], alignItems: 'center' }}>
        <View
          style={{
            width: size * 0.26,
            height: size * 0.66,
            borderWidth: line,
            borderColor: color,
            borderTopLeftRadius: 2,
            borderTopRightRadius: 2,
          }}
        />
        <View
          style={{
            width: 0,
            height: 0,
            borderLeftWidth: size * 0.13,
            borderRightWidth: size * 0.13,
            borderTopWidth: size * 0.2,
            borderLeftColor: 'transparent',
            borderRightColor: 'transparent',
            borderTopColor: color,
          }}
        />
      </View>
    </View>
  );
}

export function SearchIcon({ color, size = 22 }: Props) {
  const ring = size * 0.6;
  return (
    <View style={box(size)}>
      <View
        style={{
          width: ring,
          height: ring,
          borderRadius: ring / 2,
          borderWidth: line,
          borderColor: color,
          transform: [{ translateX: -size * 0.06 }, { translateY: -size * 0.06 }],
        }}
      />
      <View
        style={{
          position: 'absolute',
          width: size * 0.3,
          height: line + 0.25,
          borderRadius: 1,
          backgroundColor: color,
          right: size * 0.02,
          bottom: size * 0.16,
          transform: [{ rotate: '45deg' }],
        }}
      />
    </View>
  );
}

export function PlusIcon({ color, size = 20 }: Props) {
  const bar = { position: 'absolute' as const, backgroundColor: color, borderRadius: 1 };
  return (
    <View style={box(size)}>
      <View style={[bar, { width: size * 0.8, height: 2.25 }]} />
      <View style={[bar, { width: 2.25, height: size * 0.8 }]} />
    </View>
  );
}

export function EllipsisIcon({ color, size = 22 }: Props) {
  const dot = { width: 4.5, height: 4.5, borderRadius: 2.25, backgroundColor: color };
  return (
    <View style={[box(size), { flexDirection: 'row', gap: 3.5 }]}>
      <View style={dot} />
      <View style={dot} />
      <View style={dot} />
    </View>
  );
}

/** A page with a plus: a new note. */
export function NewNoteIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      <View
        style={{
          width: size * 0.72,
          height: size * 0.84,
          borderWidth: line,
          borderColor: color,
          borderRadius: 3,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <PlusIcon color={color} size={size * 0.42} />
      </View>
    </View>
  );
}

/** A folder with a plus: a new folder. */
export function NewFolderIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      <View style={{ width: size * 0.86 }}>
        <View
          style={{
            width: size * 0.36,
            height: size * 0.12,
            borderTopLeftRadius: 2,
            borderTopRightRadius: 2,
            borderWidth: line,
            borderBottomWidth: 0,
            borderColor: color,
          }}
        />
        <View
          style={{
            height: size * 0.6,
            borderWidth: line,
            borderColor: color,
            borderRadius: 3,
            borderTopLeftRadius: 0,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <PlusIcon color={color} size={size * 0.36} />
        </View>
      </View>
    </View>
  );
}

export function SortIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      <Text style={{ color, fontSize: size * 0.9, lineHeight: size, fontWeight: '300' }}>⇅</Text>
    </View>
  );
}

/** Two chevrons meeting: fold every folder away. */
export function CollapseIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      <Chevron color={color} size={size * 0.5} to="down" />
      <Chevron color={color} size={size * 0.5} to="up" />
    </View>
  );
}

export function GearIcon({ color, size = 22 }: Props) {
  return (
    <View style={box(size)}>
      {/* The variation selector asks for the plain glyph, not the emoji. */}
      <Text style={{ color, fontSize: size * 1.25, lineHeight: size * 1.35 }}>{'⚙︎'}</Text>
    </View>
  );
}
