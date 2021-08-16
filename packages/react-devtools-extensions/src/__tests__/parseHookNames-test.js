/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

// Note that this test uses React components declared in the "__source__" directory.
// This is done to control if and how the code is transformed at runtime.
// Do not declare test components within this test file as it is very fragile.

function expectHookNamesToEqual(map, expectedNamesArray) {
  // Slightly hacky since it relies on the iterable order of values()
  expect(Array.from(map.values())).toEqual(expectedNamesArray);
}

function requireText(path, encoding) {
  const {existsSync, readFileSync} = require('fs');
  if (existsSync(path)) {
    return Promise.resolve(readFileSync(path, encoding));
  } else {
    return Promise.reject(`File not found "${path}"`);
  }
}

const chromeGlobal = {
  extension: {
    getURL: jest.fn((...args) => {
      const {join} = require('path');
      return join(
        __dirname,
        '..',
        '..',
        'node_modules',
        'source-map',
        'lib',
        'mappings.wasm',
      );
    }),
  },
};

describe('parseHookNames', () => {
  let fetchMock;
  let inspectHooks;
  let parseHookNames;

  beforeEach(() => {
    jest.resetModules();

    jest.mock('source-map-support', () => {
      console.trace('source-map-support');
    });

    fetchMock = require('jest-fetch-mock');
    fetchMock.enableMocks();

    // Mock out portion of browser API used by parseHookNames to initialize "source-map".
    global.chrome = chromeGlobal;

    inspectHooks = require('react-debug-tools/src/ReactDebugHooks')
      .inspectHooks;
    parseHookNames = require('../parseHookNames/parseHookNames').parseHookNames;

    // Jest (jest-runner?) configures Errors to automatically account for source maps.
    // This changes behavior between our tests and the browser.
    // Ideally we would clear the prepareStackTrace() method on the Error object,
    // but Node falls back to looking for it on the main context's Error constructor,
    // which may still be patched.
    // To ensure we get the default behavior, override prepareStackTrace ourselves.
    // NOTE: prepareStackTrace is called from the error.stack getter, but the getter
    // has a recursion breaker which falls back to the default behavior.
    Error.prepareStackTrace = (error, trace) => {
      return error.stack;
    };

    fetchMock.mockIf(/.+$/, request => {
      return requireText(request.url, 'utf8');
    });
  });

  afterEach(() => {
    fetch.resetMocks();
  });

  async function getHookNamesForComponent(Component, props = {}) {
    const hooksTree = inspectHooks(Component, props, undefined, true);
    const hookNames = await parseHookNames(hooksTree);
    return hookNames;
  }

  it('should parse names for useState()', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithUseState')
      .Component;
    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, ['foo', 'bar', 'baz']);
  });

  it('should parse names for useReducer()', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithUseReducer')
      .Component;
    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, ['foo', 'bar', 'baz']);
  });

  it('should skip loading source files for unnamed hooks like useEffect', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithUseEffect')
      .Component;

    // Since this component contains only unnamed hooks, the source code should not even be loaded.
    fetchMock.mockIf(/.+$/, request => {
      throw Error(`Unexpected file request for "${request.url}"`);
    });

    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, []); // No hooks with names
  });

  it('should skip loading source files for unnamed hooks like useEffect (alternate)', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithExternalUseEffect')
      .Component;

    fetchMock.mockIf(/.+$/, request => {
      // Since th custom hook contains only unnamed hooks, the source code should not be loaded.
      if (request.url.endsWith('useCustom.js')) {
        throw Error(`Unexpected file request for "${request.url}"`);
      }
      return requireText(request.url, 'utf8');
    });

    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, ['count', null]); // No hooks with names
  });

  it('should parse names for custom hooks', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithNamedCustomHooks')
      .Component;
    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, [
      'foo',
      null, // Custom hooks can have names, but not when using destructuring.
      'baz',
    ]);
  });

  it('should parse names for code using hooks indirectly', async () => {
    const Component = require('./__source__/__untransformed__/ComponentUsingHooksIndirectly')
      .Component;
    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, ['count', 'darkMode', 'isDarkMode']);
  });

  it('should parse names for code using nested hooks', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithNestedHooks')
      .Component;
    let InnerComponent;
    const hookNames = await getHookNamesForComponent(Component, {
      callback: innerComponent => {
        InnerComponent = innerComponent;
      },
    });
    const innerHookNames = await getHookNamesForComponent(InnerComponent);
    expectHookNamesToEqual(hookNames, ['InnerComponent']);
    expectHookNamesToEqual(innerHookNames, ['state']);
  });

  it('should return null for custom hooks without explicit names', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithUnnamedCustomHooks')
      .Component;
    const hookNames = await getHookNamesForComponent(Component);
    expectHookNamesToEqual(hookNames, [
      null, // Custom hooks can have names, but this one does not even return a value.
      null, // Custom hooks can have names, but not when using destructuring.
    ]);
  });

  // TODO Test that cache purge works

  // TODO Test that cached metadata is purged when Fast Refresh scheduled

  describe('inline, external and bundle source maps', () => {
    it('should work for simple components', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState
        ]);
      }

      await test('./__source__/Example'); // original source (uncompiled)
      await test('./__source__/__compiled__/inline/Example'); // inline source map
      await test('./__source__/__compiled__/external/Example'); // external source map
      await test('./__source__/__compiled__/bundle/index', 'Example'); // bundle source map
      await test('./__source__/__compiled__/no-columns/Example'); // simulated Webpack 'cheap-module-source-map'
    });

    it('should work with more complex files and components', async () => {
      async function test(path, name = undefined) {
        const components = name != null ? require(path)[name] : require(path);

        let hookNames = await getHookNamesForComponent(components.List);
        expectHookNamesToEqual(hookNames, [
          'newItemText', // useState
          'items', // useState
          'uid', // useState
          'handleClick', // useCallback
          'handleKeyPress', // useCallback
          'handleChange', // useCallback
          'removeItem', // useCallback
          'toggleItem', // useCallback
        ]);

        hookNames = await getHookNamesForComponent(components.ListItem, {
          item: {},
        });
        expectHookNamesToEqual(hookNames, [
          'handleDelete', // useCallback
          'handleToggle', // useCallback
        ]);
      }

      await test('./__source__/ToDoList'); // original source (uncompiled)
      await test('./__source__/__compiled__/inline/ToDoList'); // inline source map
      await test('./__source__/__compiled__/external/ToDoList'); // external source map
      await test('./__source__/__compiled__/bundle', 'ToDoList'); // bundle source map
      await test('./__source__/__compiled__/no-columns/ToDoList'); // simulated Webpack 'cheap-module-source-map'
    });

    it('should work for custom hook', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
          'isDarkMode', // useIsDarkMode()
          'isDarkMode', // useIsDarkMode -> useState()
        ]);
      }

      await test('./__source__/ComponentWithCustomHook'); // original source (uncompiled)
      await test('./__source__/__compiled__/inline/ComponentWithCustomHook'); // inline source map
      await test('./__source__/__compiled__/external/ComponentWithCustomHook'); // external source map
      await test('./__source__/__compiled__/bundle', 'ComponentWithCustomHook'); // bundle source map
      await test(
        './__source__/__compiled__/no-columns/ComponentWithCustomHook',
      ); // simulated Webpack 'cheap-module-source-map'
    });

    it('should work when code is using hooks indirectly', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
          'darkMode', // useDarkMode()
          'isDarkMode', // useState()
        ]);
      }

      await test(
        './__source__/__compiled__/inline/ComponentUsingHooksIndirectly',
      ); // inline source map
      await test(
        './__source__/__compiled__/external/ComponentUsingHooksIndirectly',
      ); // external source map
      await test(
        './__source__/__compiled__/bundle',
        'ComponentUsingHooksIndirectly',
      ); // bundle source map
      await test(
        './__source__/__compiled__/no-columns/ComponentUsingHooksIndirectly',
      ); // simulated Webpack 'cheap-module-source-map'
    });

    it('should work when code is using nested hooks', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        let InnerComponent;
        const hookNames = await getHookNamesForComponent(Component, {
          callback: innerComponent => {
            InnerComponent = innerComponent;
          },
        });
        const innerHookNames = await getHookNamesForComponent(InnerComponent);
        expectHookNamesToEqual(hookNames, [
          'InnerComponent', // useMemo()
        ]);
        expectHookNamesToEqual(innerHookNames, [
          'state', // useState()
        ]);
      }

      await test('./__source__/__compiled__/inline/ComponentWithNestedHooks'); // inline source map
      await test('./__source__/__compiled__/external/ComponentWithNestedHooks'); // external source map
      await test(
        './__source__/__compiled__/bundle',
        'ComponentWithNestedHooks',
      ); // bundle source map
      await test(
        './__source__/__compiled__/no-columns/ComponentWithNestedHooks',
      ); // simulated Webpack 'cheap-module-source-map'
    });

    it('should work for external hooks', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'theme', // useTheme()
          'theme', // useContext()
        ]);
      }

      // We can't test the uncompiled source here, because it either needs to get transformed,
      // which would break the source mapping, or the import statements will fail.

      await test(
        './__source__/__compiled__/inline/ComponentWithExternalCustomHooks',
      ); // inline source map
      await test(
        './__source__/__compiled__/external/ComponentWithExternalCustomHooks',
      ); // external source map
      await test(
        './__source__/__compiled__/bundle',
        'ComponentWithExternalCustomHooks',
      ); // bundle source map
      await test(
        './__source__/__compiled__/no-columns/ComponentWithExternalCustomHooks',
      ); // simulated Webpack 'cheap-module-source-map'
    });

    it('should work when multiple hooks are on a line', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'a', // useContext()
          'b', // useContext()
          'c', // useContext()
          'd', // useContext()
        ]);
      }

      await test(
        './__source__/__compiled__/inline/ComponentWithMultipleHooksPerLine',
      ); // inline source map
      await test(
        './__source__/__compiled__/external/ComponentWithMultipleHooksPerLine',
      ); // external source map
      await test(
        './__source__/__compiled__/bundle',
        'ComponentWithMultipleHooksPerLine',
      ); // bundle source map

      async function noColumnTest(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'a', // useContext()
          'b', // useContext()
          null, // useContext()
          null, // useContext()
        ]);
      }

      // Note that this test is expected to only match the first two hooks
      // because the 3rd and 4th hook are on the same line,
      // and this type of source map doesn't have column numbers.
      await noColumnTest(
        './__source__/__compiled__/no-columns/ComponentWithMultipleHooksPerLine',
      ); // simulated Webpack 'cheap-module-source-map'
    });

    // TODO Inline require (e.g. require("react").useState()) isn't supported yet.
    // Maybe this isn't an important use case to support,
    // since inline requires are most likely to exist in compiled source (if at all).
    xit('should work for inline requires', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
        ]);
      }

      await test('./__source__/InlineRequire'); // original source (uncompiled)
      await test('./__source__/__compiled__/inline/InlineRequire'); // inline source map
      await test('./__source__/__compiled__/external/InlineRequire'); // external source map
      await test('./__source__/__compiled__/bundle', 'InlineRequire'); // bundle source map
      await test('./__source__/__compiled__/no-columns/InlineRequire'); // simulated Webpack 'cheap-module-source-map'
    });

    it('should support sources that contain the string "sourceMappingURL="', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
        ]);
      }

      // We expect the inline sourceMappingURL to be invalid in this case; mute the warning.
      console.warn = () => {};

      await test('./__source__/ContainingStringSourceMappingURL'); // original source (uncompiled)
      await test(
        './__source__/__compiled__/inline/ContainingStringSourceMappingURL',
      ); // inline source map
      await test(
        './__source__/__compiled__/external/ContainingStringSourceMappingURL',
      ); // external source map
      await test(
        './__source__/__compiled__/bundle',
        'ContainingStringSourceMappingURL',
      ); // bundle source map
      await test(
        './__source__/__compiled__/no-columns/ContainingStringSourceMappingURL',
      ); // simulated Webpack 'cheap-module-source-map'
    });
  });

  describe('extended source maps', () => {
    let parseMock;

    beforeEach(() => {
      parseMock = jest.fn();
      jest.mock('@babel/parser', () => {
        const actual = jest.requireActual('@babel/parser');
        const parse = (...args) => {
          parseMock();
          return actual.parse(...args);
        };
        return {
          parse,
          ...actual,
        };
      });
    });

    it('should work for simple components', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test('./__source__/Example'); // original source (uncompiled)
      await test(
        './__source__/__compiled__/inline/fb-sources-extended/Example',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/Example',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/Example',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/Example',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should work with more complex files and components', async () => {
      async function test(path, name = undefined) {
        const components = name != null ? require(path)[name] : require(path);

        let hookNames = await getHookNamesForComponent(components.List);
        expectHookNamesToEqual(hookNames, [
          'newItemText', // useState
          'items', // useState
          'uid', // useState
          'handleClick', // useCallback
          'handleKeyPress', // useCallback
          'handleChange', // useCallback
          'removeItem', // useCallback
          'toggleItem', // useCallback
        ]);

        hookNames = await getHookNamesForComponent(components.ListItem, {
          item: {},
        });
        expectHookNamesToEqual(hookNames, [
          'handleDelete', // useCallback
          'handleToggle', // useCallback
        ]);

        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test('./__source__/ToDoList'); // original source (uncompiled)
      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ToDoList',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ToDoList',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ToDoList',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ToDoList',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should work for custom hook', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
          'isDarkMode', // useIsDarkMode()
          'isDarkMode', // useIsDarkMode -> useState()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test('./__source__/ComponentWithCustomHook'); // original source (uncompiled)
      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ComponentWithCustomHook',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ComponentWithCustomHook',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ComponentWithCustomHook',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ComponentWithCustomHook',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should work when code is using hooks indirectly', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
          'darkMode', // useDarkMode()
          'isDarkMode', // useState()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ComponentUsingHooksIndirectly',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ComponentUsingHooksIndirectly',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ComponentUsingHooksIndirectly',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ComponentUsingHooksIndirectly',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should work when code is using nested hooks', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        let InnerComponent;
        const hookNames = await getHookNamesForComponent(Component, {
          callback: innerComponent => {
            InnerComponent = innerComponent;
          },
        });
        const innerHookNames = await getHookNamesForComponent(InnerComponent);
        expectHookNamesToEqual(hookNames, [
          'InnerComponent', // useMemo()
        ]);
        expectHookNamesToEqual(innerHookNames, [
          'state', // useState()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ComponentWithNestedHooks',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ComponentWithNestedHooks',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ComponentWithNestedHooks',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ComponentWithNestedHooks',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should work for external hooks', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'theme', // useTheme()
          'theme', // useContext()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      // We can't test the uncompiled source here, because it either needs to get transformed,
      // which would break the source mapping, or the import statements will fail.

      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ComponentWithExternalCustomHooks',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ComponentWithExternalCustomHooks',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ComponentWithExternalCustomHooks',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ComponentWithExternalCustomHooks',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should work when multiple hooks are on a line', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'a', // useContext()
          'b', // useContext()
          'c', // useContext()
          'd', // useContext()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ComponentWithMultipleHooksPerLine',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ComponentWithMultipleHooksPerLine',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ComponentWithMultipleHooksPerLine',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ComponentWithMultipleHooksPerLine',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    // TODO Inline require (e.g. require("react").useState()) isn't supported yet.
    // Maybe this isn't an important use case to support,
    // since inline requires are most likely to exist in compiled source (if at all).
    xit('should work for inline requires', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      await test('./__source__/InlineRequire'); // original source (uncompiled)
      await test(
        './__source__/__compiled__/inline/fb-sources-extended/InlineRequire',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/InlineRequire',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/InlineRequire',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/InlineRequire',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });

    it('should support sources that contain the string "sourceMappingURL="', async () => {
      async function test(path, name = 'Component') {
        const Component = require(path)[name];
        const hookNames = await getHookNamesForComponent(Component);
        expectHookNamesToEqual(hookNames, [
          'count', // useState()
        ]);
        expect(parseMock).toHaveBeenCalledTimes(0);
      }

      // We expect the inline sourceMappingURL to be invalid in this case; mute the warning.
      console.warn = () => {};

      await test('./__source__/ContainingStringSourceMappingURL'); // original source (uncompiled)
      await test(
        './__source__/__compiled__/inline/fb-sources-extended/ContainingStringSourceMappingURL',
      ); // x_fb_sources extended inline source map
      await test(
        './__source__/__compiled__/external/fb-sources-extended/ContainingStringSourceMappingURL',
      ); // x_fb_sources extended external source map
      await test(
        './__source__/__compiled__/inline/react-sources-extended/ContainingStringSourceMappingURL',
      ); // x_react_sources extended inline source map
      await test(
        './__source__/__compiled__/external/react-sources-extended/ContainingStringSourceMappingURL',
      ); // x_react_sources extended external source map
      // TODO test no-columns and bundle cases with extended source maps
    });
  });
});

describe('parseHookNames worker', () => {
  let inspectHooks;
  let parseHookNames;
  let workerizedParseHookNamesMock;

  beforeEach(() => {
    window.Worker = undefined;

    workerizedParseHookNamesMock = jest.fn();

    jest.mock('../parseHookNames/parseHookNames.worker.js', () => {
      return {
        __esModule: true,
        default: () => ({
          parseHookNames: workerizedParseHookNamesMock,
        }),
      };
    });

    // Mock out portion of browser API used by parseHookNames to initialize "source-map".
    global.chrome = chromeGlobal;

    inspectHooks = require('react-debug-tools/src/ReactDebugHooks')
      .inspectHooks;
    parseHookNames = require('../parseHookNames').parseHookNames;
  });

  async function getHookNamesForComponent(Component, props = {}) {
    const hooksTree = inspectHooks(Component, props, undefined, true);
    const hookNames = await parseHookNames(hooksTree);
    return hookNames;
  }

  it('should use worker', async () => {
    const Component = require('./__source__/__untransformed__/ComponentWithUseState')
      .Component;

    window.Worker = true;
    // resets module so mocked worker instance can be updated
    jest.resetModules();
    parseHookNames = require('../parseHookNames').parseHookNames;

    await getHookNamesForComponent(Component);
    expect(workerizedParseHookNamesMock).toHaveBeenCalledTimes(1);
  });
});