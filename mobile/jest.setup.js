/**
 * The generic test doubles for the storage backends. Individual test files
 * (host-store.test.ts) install their own in-memory fakes; this file only
 * guarantees that importing the store modules NEVER touches a real native
 * bridge from any other test.
 */

jest.mock("expo-secure-store", () => ({
  getItemAsync: jest.fn(async () => null),
  setItemAsync: jest.fn(async () => undefined),
  deleteItemAsync: jest.fn(async () => undefined),
}));

jest.mock("@react-native-async-storage/async-storage", () => ({
  getItem: jest.fn(async () => null),
  setItem: jest.fn(async () => undefined),
  removeItem: jest.fn(async () => undefined),
  multiSet: jest.fn(async () => undefined),
  multiRemove: jest.fn(async () => undefined),
}));
