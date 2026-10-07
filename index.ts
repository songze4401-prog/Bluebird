import React from 'react';
import { registerRootComponent } from 'expo';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import App from './App';

// SafeAreaProvider 必须位于应用最外层：
// 原生端是官方推荐做法，web 端则是必需 —— 缺少它时 SafeAreaView 会抛
// "No safe area value available" 并导致整棵树卸载（白屏）。
// index.ts 不能写 JSX，所以用 createElement 组装根组件。
function Root() {
  return React.createElement(
    SafeAreaProvider,
    null,
    React.createElement(App)
  );
}

// registerRootComponent calls AppRegistry.registerComponent('main', () => App);
// It also ensures that whether you load the app in Expo Go or in a native build,
// the environment is set up appropriately
registerRootComponent(Root);
