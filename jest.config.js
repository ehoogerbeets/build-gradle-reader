export default {
    testEnvironment: 'node',
    transform: {
        '^.+\\.ts$': ['@swc/jest', {
            jsc: {
                target: 'es2015',
                parser: {
                    syntax: 'typescript',
                },
            },
            module: {
                type: 'es6',
            },
        }],
    },
    moduleNameMapper: {
        '^(\\.{1,2}/.*)\\.js$': '$1',
    },
    testMatch: ['**/test/**/*.test.ts'],
    extensionsToTreatAsEsm: ['.ts'],
};

