package host

import "time"

// runObservedDecision 给一次完整的 Arbiter 裁定补齐可观察生命周期。
// Arbiter 仍是非流式 LLM 函数；这里只复用现有事件 ID 的开始/结束原地更新机制，
// 不引入额外状态，也不把结构化 JSON 混进 Worker 的实时输出面板。
func runObservedDecision[T any](o *observer, label string, call func() (T, error)) (T, error) {
	if o == nil {
		return call()
	}
	started := time.Now()
	id := nextEventID()
	o.emitAndLog(Event{
		ID:       id,
		Time:     started,
		Category: "DECISION",
		Agent:    "arbiter",
		Summary:  label,
		Level:    "info",
	})

	result, err := call()
	finished := time.Now()
	ev := Event{
		ID:         id,
		Time:       started,
		FinishedAt: finished,
		Failed:     err != nil,
		Category:   "DECISION",
		Agent:      "arbiter",
		Summary:    label,
		Level:      "success",
		Duration:   finished.Sub(started),
	}
	if err != nil {
		ev.Level = "error"
		ev.Detail = err.Error()
		ev.Kind = errorKind(err, err.Error())
	}
	o.emitEv(ev)
	o.persistEvent(ev)
	return result, err
}
