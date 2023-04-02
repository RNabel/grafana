import { cx } from '@emotion/css';
import { Configuration, OpenAIApi } from 'openai';
import { LanguageMap, languages as prismLanguages } from 'prismjs';
import React, { ReactNode } from 'react';
import { Plugin } from 'slate';
import { Editor } from 'slate-react';

import { isDataFrame, QueryEditorProps, QueryHint, TimeRange, toLegacyResponseData } from '@grafana/data';
import { reportInteraction } from '@grafana/runtime/src';
import {
  BracesPlugin,
  Button,
  DOMUtil,
  Icon,
  SlatePrism,
  Spinner,
  SuggestionsState,
  TypeaheadInput,
  TypeaheadOutput,
  Themeable2,
  withTheme2,
  clearButtonStyles,
} from '@grafana/ui';
import { LocalStorageValueProvider } from 'app/core/components/LocalStorageValueProvider';
import {
  CancelablePromise,
  isCancelablePromiseRejection,
  makePromiseCancelable,
} from 'app/core/utils/CancelablePromise';

import { PrometheusDatasource } from '../datasource';
import { roundMsToMin } from '../language_utils';
import { PromOptions, PromQuery } from '../types';

import { PrometheusMetricsBrowser } from './PrometheusMetricsBrowser';
import { MonacoQueryFieldWrapper } from './monaco-query-field/MonacoQueryFieldWrapper';

const openAiKey = process.env.REACT_APP_OPENAI_API_KEY;
const configuration: Configuration = new Configuration({
  apiKey: openAiKey,
});

const openai: OpenAIApi = new OpenAIApi(configuration);

export const RECORDING_RULES_GROUP = '__recording_rules__';
const LAST_USED_LABELS_KEY = 'grafana.datasources.prometheus.browser.labels';

function getChooserText(metricsLookupDisabled: boolean, hasSyntax: boolean, hasMetrics: boolean) {
  if (metricsLookupDisabled) {
    return '(Disabled)';
  }

  if (!hasSyntax) {
    return 'Loading metrics...';
  }

  if (!hasMetrics) {
    return '(No metrics found)';
  }

  return 'Metrics browser';
}

export function willApplySuggestion(suggestion: string, { typeaheadContext, typeaheadText }: SuggestionsState): string {
  // Modify suggestion based on context
  switch (typeaheadContext) {
    case 'context-labels': {
      const nextChar = DOMUtil.getNextCharacter();
      if (!nextChar || nextChar === '}' || nextChar === ',') {
        suggestion += '=';
      }
      break;
    }

    case 'context-label-values': {
      // Always add quotes and remove existing ones instead
      if (!typeaheadText.match(/^(!?=~?"|")/)) {
        suggestion = `"${suggestion}`;
      }
      if (DOMUtil.getNextCharacter() !== '"') {
        suggestion = `${suggestion}"`;
      }
      break;
    }

    default:
  }
  return suggestion;
}

interface PromQueryFieldProps extends QueryEditorProps<PrometheusDatasource, PromQuery, PromOptions>, Themeable2 {
  ExtraFieldElement?: ReactNode;
  'data-testid'?: string;
}

interface PromQueryFieldState {
  labelBrowserVisible: boolean;
  syntaxLoaded: boolean;
  hint: QueryHint | null;
  hasError: boolean;
  aiHelp: string;
  loadingAiHelp: boolean;
  showAiHelpModal: boolean;
}

class PromQueryField extends React.PureComponent<PromQueryFieldProps, PromQueryFieldState> {
  plugins: Array<Plugin<Editor>>;
  declare languageProviderInitializationPromise: CancelablePromise<any>;

  constructor(props: PromQueryFieldProps, context: React.Context<any>) {
    super(props, context);

    this.plugins = [
      BracesPlugin(),
      SlatePrism(
        {
          onlyIn: (node: any) => node.type === 'code_block',
          getSyntax: (node: any) => 'promql',
        },
        { ...(prismLanguages as LanguageMap), promql: this.props.datasource.languageProvider.syntax }
      ),
    ];

    this.state = {
      labelBrowserVisible: false,
      syntaxLoaded: false,
      hint: null,
      hasError: false,
      aiHelp: '',
      loadingAiHelp: false,
      showAiHelpModal: false,
    };
  }

  componentDidMount() {
    if (this.props.datasource.languageProvider) {
      this.refreshMetrics();
    }
    this.refreshHint();
  }

  componentWillUnmount() {
    if (this.languageProviderInitializationPromise) {
      this.languageProviderInitializationPromise.cancel();
    }
  }

  componentDidUpdate(prevProps: PromQueryFieldProps) {
    const {
      data,
      datasource: { languageProvider },
      range,
    } = this.props;

    if (languageProvider !== prevProps.datasource.languageProvider) {
      // We reset this only on DS change so we do not flesh loading state on every rangeChange which happens on every
      // query run if using relative range.
      this.setState({
        syntaxLoaded: false,
      });
    }

    const changedRangeToRefresh = this.rangeChangedToRefresh(range, prevProps.range);
    // We want to refresh metrics when language provider changes and/or when range changes (we round up intervals to a minute)
    if (languageProvider !== prevProps.datasource.languageProvider || changedRangeToRefresh) {
      this.refreshMetrics();
    }

    if (data && prevProps.data && prevProps.data.series !== data.series) {
      this.refreshHint();
    }
    const prevError = (prevProps.data?.errors ?? []).length > 0;
    const currentError = (this.props.data?.errors ?? []).length > 0;
    if (prevError !== currentError) {
      this.setState({ hasError: currentError });
    }
  }

  refreshHint = () => {
    const { datasource, query, data } = this.props;
    const initHints = datasource.getInitHints();
    const initHint = initHints.length > 0 ? initHints[0] : null;

    if (!data || data.series.length === 0) {
      this.setState({
        hint: initHint,
      });
      return;
    }

    const result = isDataFrame(data.series[0]) ? data.series.map(toLegacyResponseData) : data.series;
    const queryHints = datasource.getQueryHints(query, result);
    let queryHint = queryHints.length > 0 ? queryHints[0] : null;

    this.setState({ hint: queryHint ?? initHint });
  };

  refreshMetrics = async () => {
    const {
      datasource: { languageProvider },
    } = this.props;

    this.languageProviderInitializationPromise = makePromiseCancelable(languageProvider.start());

    try {
      const remainingTasks = await this.languageProviderInitializationPromise.promise;
      await Promise.all(remainingTasks);
      this.onUpdateLanguage();
    } catch (err) {
      if (isCancelablePromiseRejection(err) && err.isCanceled) {
        // do nothing, promise was canceled
      } else {
        throw err;
      }
    }
  };

  rangeChangedToRefresh(range?: TimeRange, prevRange?: TimeRange): boolean {
    if (range && prevRange) {
      const sameMinuteFrom = roundMsToMin(range.from.valueOf()) === roundMsToMin(prevRange.from.valueOf());
      const sameMinuteTo = roundMsToMin(range.to.valueOf()) === roundMsToMin(prevRange.to.valueOf());
      // If both are same, don't need to refresh.
      return !(sameMinuteFrom && sameMinuteTo);
    }
    return false;
  }

  /**
   * TODO #33976: Remove this, add histogram group (query = `histogram_quantile(0.95, sum(rate(${metric}[5m])) by (le))`;)
   */
  onChangeLabelBrowser = (selector: string) => {
    this.onChangeQuery(selector, true);
    this.setState({ labelBrowserVisible: false });
  };

  onChangeQuery = (value: string, override?: boolean) => {
    // Send text change to parent
    const { query, onChange, onRunQuery } = this.props;
    if (onChange) {
      const nextQuery: PromQuery = { ...query, expr: value };
      onChange(nextQuery);

      if (override && onRunQuery) {
        onRunQuery();
      }
    }

    // Reset and close the AI Help section
    this.setState({ aiHelp: '' });
  };

  onClickChooserButton = () => {
    this.setState((state) => ({ labelBrowserVisible: !state.labelBrowserVisible }));

    reportInteraction('user_grafana_prometheus_metrics_browser_clicked', {
      editorMode: this.state.labelBrowserVisible ? 'metricViewClosed' : 'metricViewOpen',
      app: this.props?.app ?? '',
    });
  };

  onClickHintFix = () => {
    const { datasource, query, onChange, onRunQuery } = this.props;
    const { hint } = this.state;
    if (hint?.fix?.action) {
      onChange(datasource.modifyQuery(query, hint.fix.action));
    }
    onRunQuery();
  };

  onUpdateLanguage = () => {
    const {
      datasource: { languageProvider },
    } = this.props;
    const { metrics } = languageProvider;

    if (!metrics) {
      return;
    }

    this.setState({ syntaxLoaded: true });
  };

  onTypeahead = async (typeahead: TypeaheadInput): Promise<TypeaheadOutput> => {
    const {
      datasource: { languageProvider },
    } = this.props;

    if (!languageProvider) {
      return { suggestions: [] };
    }

    const { history } = this.props;
    const { prefix, text, value, wrapperClasses, labelKey } = typeahead;

    const result = await languageProvider.provideCompletionItems(
      { text, value, prefix, wrapperClasses, labelKey },
      { history }
    );

    return result;
  };

  // AI Help Text
  showAiHelpText = (aiHelp: string) => {
    this.setState({ showAiHelpModal: true, aiHelp });
  };
  hideAiHelpText = () => {
    this.setState({ showAiHelpModal: false });
  };

  acceptAiHelp = () => {
    const { query, onChange, onRunQuery } = this.props;
    onChange({ ...query, expr: this.state.aiHelp });
    onRunQuery();
    this.setState({ aiHelp: '' });
  };

  closeAiHelp = () => {
    this.setState({ aiHelp: '' });
  };

  applyAiHelp = () => {
    const { query, onChange, onRunQuery } = this.props;
    const { aiHelp } = this.state;
    onChange({ ...query, expr: aiHelp });
    onRunQuery();
    this.hideAiHelpText();
  };

  handleHelpButtonClick = async () => {
    const PROMPT = `
You are an AI code assistant in Grafana for the Prometheus data source. The user calls on you by clicking Get AI Help. Adjust the query to run successfully.

You will receive both the query and the error of the user query.

Your response will be placed directly in the user's query field.

Your response MUST be PromQL only, no text
All PromQL should be correctly formatted and indented. All comments must be prefixed with the \`#\` character.

e.g.

Request:
\`\`\`
Query: 
\`\`\`
node_context_switches_total,_
\`\`\`
Error:
\`\`\`
bad_data: 1:28: parse error: unexpected ","
\`\`\`

# I removed the trailing comma as it was invalid PromQL.
node_context_switches_total
`;

    function formatQueryAndError(query: string, error?: string): string {
      let errorString = '';
      if (error) {
        errorString = `
Error:
\`\`\`
${error}
\`\`\`
    `;
      }
      return `
Request:
\`\`\`
Query: 
\`\`\`
${query}
\`\`\`${errorString}
  `;
    }
    const { query } = this.props;
    const error = (this.props.data?.errors ?? [])
      .map((error) => error.message)
      .filter((value): value is string => value !== undefined)
      .at(0);
    console.log('Error:', error);

    try {
      this.setState({ loadingAiHelp: true });
      const completion = await openai.createChatCompletion({
        model: 'gpt-3.5-turbo',
        messages: [
          { role: 'system', content: PROMPT },
          { role: 'assistant', content: formatQueryAndError(query.expr, error) },
        ],
      });

      const response = completion.data.choices[0].message?.content ?? query.expr;
      console.log(response);

      if (response !== undefined) {
        // Show AI Help modal!
        this.showAiHelpText(response);
      }
    } catch (err) {
      console.error('Error sending query to third-party system:', err);
    }
    this.setState({ loadingAiHelp: false });
  };

  renderAIHelpButton() {
    if (this.state.hasError) {
      return (
        <div className="query-row-break">
          <Button onClick={this.handleHelpButtonClick} variant="secondary" disabled={this.state.loadingAiHelp}>
            {this.state.loadingAiHelp ? (
              <>
                <Spinner inline style={{ margin: '5px' }} />
                Loading help...
              </>
            ) : (
              <>
                <Icon name="question-circle" style={{ margin: '5px' }} />
                Get AI Help
              </>
            )}
          </Button>
        </div>
      );
    }
    return null;
  }

  render() {
    const {
      datasource,
      datasource: { languageProvider },
      query,
      ExtraFieldElement,
      history = [],
      theme,
    } = this.props;

    const { labelBrowserVisible, syntaxLoaded, hint } = this.state;
    const hasMetrics = languageProvider.metrics.length > 0;
    const chooserText = getChooserText(datasource.lookupsDisabled, syntaxLoaded, hasMetrics);
    const buttonDisabled = !(syntaxLoaded && hasMetrics);

    return (
      <LocalStorageValueProvider<string[]> storageKey={LAST_USED_LABELS_KEY} defaultValue={[]}>
        {(lastUsedLabels, onLastUsedLabelsSave, onLastUsedLabelsDelete) => {
          return (
            <>
              <div
                className="gf-form-inline gf-form-inline--xs-view-flex-column flex-grow-1"
                data-testid={this.props['data-testid']}
              >
                <button
                  className="gf-form-label query-keyword pointer"
                  onClick={this.onClickChooserButton}
                  disabled={buttonDisabled}
                  type="button"
                >
                  {chooserText}
                  <Icon name={labelBrowserVisible ? 'angle-down' : 'angle-right'} />
                </button>

                <div className="gf-form gf-form--grow flex-shrink-1 min-width-15">
                  <MonacoQueryFieldWrapper
                    languageProvider={languageProvider}
                    history={history}
                    onChange={this.onChangeQuery}
                    onRunQuery={this.props.onRunQuery}
                    initialValue={query.expr ?? ''}
                    placeholder="Enter a PromQL query…"
                  />
                </div>
              </div>
              {labelBrowserVisible && (
                <div className="gf-form">
                  <PrometheusMetricsBrowser
                    languageProvider={languageProvider}
                    onChange={this.onChangeLabelBrowser}
                    lastUsedLabels={lastUsedLabels || []}
                    storeLastUsedLabels={onLastUsedLabelsSave}
                    deleteLastUsedLabels={onLastUsedLabelsDelete}
                  />
                </div>
              )}

              {ExtraFieldElement}
              {hint ? (
                <div className="query-row-break">
                  <div className="prom-query-field-info text-warning">
                    {hint.label}{' '}
                    {hint.fix ? (
                      <button
                        type="button"
                        className={cx(clearButtonStyles(theme), 'text-link', 'muted')}
                        onClick={this.onClickHintFix}
                      >
                        {hint.fix.label}
                      </button>
                    ) : null}
                  </div>
                </div>
              ) : null}
              {this.renderAIHelpButton()}
              {this.state.aiHelp && (
                <div className="query-row-break">
                  <h2 style={{ marginTop: '8px' }}>Does this help?</h2>
                  <pre>{this.state.aiHelp}</pre>
                  <div>
                    <Button
                      onClick={this.acceptAiHelp}
                      variant="secondary"
                      type="button"
                      style={{ marginRight: '10px' }}
                    >
                      Accept
                    </Button>
                    <Button onClick={this.closeAiHelp} variant="destructive">
                      Close
                    </Button>
                  </div>
                </div>
              )}
            </>
          );
        }}
      </LocalStorageValueProvider>
    );
  }
}

export default withTheme2(PromQueryField);
