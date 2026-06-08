# Changelog

## [0.1.1](https://github.com/alperu/soundsuite/compare/v0.1.0...v0.1.1) (2026-06-08)


### Bug Fixes

* **haystack/commit:** stop double-stringifying tags JSON; filter column fields from patch ([1774542](https://github.com/alperu/soundsuite/commit/1774542e4447a9204bb7dd8fd597af3c50804f60))
* override FAN_HOME before booting @haxall/haxall so a bad shell env can't crash the server ([c5abaf0](https://github.com/alperu/soundsuite/commit/c5abaf0d9363a53ccb883ce9d27764be190770d0))
* **personas:** derive markers + rolesCount server-side; harden table render ([317cc33](https://github.com/alperu/soundsuite/commit/317cc338aa411f6d8e31593e7550d8e818e66e1c))
* **personas:** unwrap { persona } envelope in client.ts so id propagates ([09e2e40](https://github.com/alperu/soundsuite/commit/09e2e4070262fd80ef9932a10487dae69d183918))
* **xeto-namespace:** delete inherited FAN_HOME instead of overriding it ([4ae5aa2](https://github.com/alperu/soundsuite/commit/4ae5aa2a0ddf40b6618f999adc7a1da53fbb46a2))
* **xeto:** bypass @haxall/haxall's broken auto-pod-import + soft-fail validation ([acf86cd](https://github.com/alperu/soundsuite/commit/acf86cd47a9ed11a1a1249ad38f99e83aa5c97a4))
