package setting

func (cfg *Cfg) readOpenAiSettings() error {
	openaiSection := cfg.Raw.Section("openai")

	cfg.OpenAiApiKey = openaiSection.Key("api_key").MustString("yolo_key_1")

	return nil
}
