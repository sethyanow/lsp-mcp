module.exports = {
    testEnvironment: 'node',
    roots: ['<rootDir>/src/tests'],
    transform: {
        '^.+\\.tsx?$': [
            'ts-jest',
            {
                tsconfig: {
                    target: 'es2020',
                    module: 'node16',
                    moduleResolution: 'node16',
                    preserveConstEnums: false,
                },
                diagnostics: {
                    ignoreCodes: [151002],
                },
            },
        ],
    },
    testRegex: '(/__tests__/.*|(\\.|/)(test|spec))\\.tsx?$',
    moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
};
