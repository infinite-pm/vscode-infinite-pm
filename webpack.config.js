const path = require('path');
const webpack = require('webpack');

module.exports = {
    target: 'node',
    entry: './src/extension/index.ts',
    output: {
        path: path.resolve(__dirname, 'dist/extension'),
        filename: 'index.js',
        libraryTarget: 'commonjs2'
    },
    externals: {
        vscode: 'commonjs vscode'
    },
    resolve: {
        extensions: ['.ts', '.js']
    },
    module: {
        rules: [
            {
                test: /\.ts$/,
                exclude: [/node_modules/, /__tests__/],
                use: [
                    {
                        loader: 'ts-loader',
                        options: {
                            configFile: 'tsconfig.json',
                            onlyCompileBundledFiles: true
                        }
                    }
                ]
            }
        ]
    },
    plugins: [
        new webpack.DefinePlugin({
            'BUILD_TIMESTAMP': JSON.stringify(new Date().toISOString())
        })
    ],
    devtool: 'nosources-source-map',
    infrastructureLogging: {
        level: 'log'
    }
};
