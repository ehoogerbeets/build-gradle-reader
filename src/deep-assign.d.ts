declare module 'deep-assign' {
    function deepAssign<T, U>(target: T, source: U): T & U;
    function deepAssign<T, U, V>(target: T, source1: U, source2: V): T & U & V;
    function deepAssign<T, U, V, W>(target: T, source1: U, source2: V, source3: W): T & U & V & W;
    function deepAssign(target: any, ...sources: any[]): any;
    export = deepAssign;
}

