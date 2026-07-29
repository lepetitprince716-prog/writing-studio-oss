declare module 'd3-force-3d' {
  export interface ForceNode {
    index?: number;
    x?: number;
    y?: number;
    z?: number;
    vx?: number;
    vy?: number;
    vz?: number;
    fx?: number | null;
    fy?: number | null;
    fz?: number | null;
  }

  export interface Force<Datum extends ForceNode> {
    (alpha: number): void;
    initialize?(nodes: Datum[], random: () => number, dimensions: number): void;
  }

  export interface Simulation<Datum extends ForceNode> {
    restart(): this;
    stop(): this;
    tick(iterations?: number): this;
    numDimensions(): number;
    numDimensions(value: 1 | 2 | 3): this;
    nodes(): Datum[];
    nodes(nodes: Datum[]): this;
    alpha(): number;
    alpha(value: number): this;
    alphaMin(): number;
    alphaMin(value: number): this;
    alphaDecay(value: number): this;
    velocityDecay(value: number): this;
    force(name: string, force: Force<Datum> | null): this;
    on(name: 'tick' | 'end', listener: (() => void) | null): this;
  }

  export interface CenterForce<Datum extends ForceNode> extends Force<Datum> {
    strength(value: number): this;
  }

  export interface ManyBodyForce<Datum extends ForceNode> extends Force<Datum> {
    strength(value: number | ((node: Datum) => number)): this;
    distanceMin(value: number): this;
    distanceMax(value: number): this;
    theta(value: number): this;
  }

  export interface LinkDatum<Datum extends ForceNode> {
    source: string | Datum;
    target: string | Datum;
  }

  export interface LinkForce<Datum extends ForceNode, Link extends LinkDatum<Datum>> extends Force<Datum> {
    id(value: (node: Datum) => string): this;
    distance(value: number | ((link: Link) => number)): this;
    strength(value: number | ((link: Link) => number)): this;
    links(value: Link[]): this;
  }

  export function forceSimulation<Datum extends ForceNode>(
    nodes?: Datum[],
    dimensions?: 1 | 2 | 3,
  ): Simulation<Datum>;
  export function forceCenter<Datum extends ForceNode>(x?: number, y?: number, z?: number): CenterForce<Datum>;
  export function forceManyBody<Datum extends ForceNode>(): ManyBodyForce<Datum>;
  export function forceLink<Datum extends ForceNode, Link extends LinkDatum<Datum>>(
    links?: Link[],
  ): LinkForce<Datum, Link>;
}
