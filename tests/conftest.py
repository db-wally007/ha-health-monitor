"""Tests run from a checkout outside the Home Assistant config dir:
    pip install pytest-homeassistant-custom-component
    pytest tests/
They import the integration's modules directly, so no custom-integration loading is
needed - which also lets the recorder fixture set up before hass, as it must."""
