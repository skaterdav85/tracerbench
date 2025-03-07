import chalk from 'chalk';

import { Command } from '@oclif/command';
import {
  bucketPhaseValues,
  formatPhaseData,
  HTMLSectionRenderData,
  ITracerBenchTraceResult,
  PAGE_LOAD_TIME,
} from './create-consumable-html';
import { Stats, ISevenFigureSummary } from './statistics/stats';
import TBTable from './table';
import { ICompareFlags } from '../commands/compare';
import { fidelityLookup } from '../command-config';
import { chalkScheme } from './utils';

export interface ICompareJSONResult {
  heading: string;
  phaseName: string;
  isSignificant: boolean;
  estimatorDelta: string;
  controlSampleCount: number;
  experimentSampleCount: number;
  confidenceInterval: string[];
  controlSevenFigureSummary: ISevenFigureSummary;
  experimentSevenFigureSummary: ISevenFigureSummary;
}

export interface ICompareJSONResults {
  benchmarkTableData: ICompareJSONResult[];
  phaseTableData: ICompareJSONResult[];
  areResultsSignificant: boolean;
  isBelowRegressionThreshold: boolean;
}

/**
 * If fidelity is at acceptable number, return true if any of the phase results were significant
 *
 * @param fidelity - Use this to determine if the sample count is too low
 * @param benchmarkIsSigArray - Array of strings of either "Yes" or "No" from TBTable
 * @param phaseIsSigArray - Array of strings of either "Yes" or "No" from TBTable
 */
export function anyResultsSignificant(
  fidelity: number,
  benchmarkIsSigArray: boolean[],
  phaseIsSigArray: boolean[]
): boolean {
  // if fidelity !== 'test'
  if (fidelity > fidelityLookup.test) {
    return benchmarkIsSigArray.includes(true) || phaseIsSigArray.includes(true);
  }
  return false;
}

export function allBelowRegressionThreshold(
  regressionThreshold: number | undefined,
  benchmarkTableEstimatorDeltas: number[],
  phaseTableEstimatorDeltas: number[]
): boolean {
  if (regressionThreshold) {
    const deltas: number[] = benchmarkTableEstimatorDeltas.concat(
      phaseTableEstimatorDeltas
    );
    // if regression is over the threshold this should return false;
    return deltas.every(x => x > regressionThreshold);
  }
  return true;
}

/**
 * Output meta data about the benchmark run and FYI messages to the user.
 *
 * @param cli - This is expected to be a "compare" Command instance
 * @param cliFlags - This is expected to be CLI flags from the "compare" command
 * @param isBelowRegressionThreshold - Boolean indicating if there were any deltas below "regressionThreshold" flag
 */
export function outputRunMetaMessagesAndWarnings(
  cli: Command,
  cliFlags: Partial<ICompareFlags>,
  isBelowRegressionThreshold: boolean
) {
  const { fidelity, regressionThreshold } = cliFlags;
  const LOW_FIDELITY_WARNING =
    'The fidelity setting was set below the recommended for a viable result. Rerun TracerBench with at least "fidelity=low"';

  if ((fidelity as number) < 10) {
    cli.log(`\n${chalk.black.bgYellow(' WARNING ')} ${LOW_FIDELITY_WARNING}\n`);
  }

  if (!isBelowRegressionThreshold) {
    cli.log(
      `A regression was found exceeding the set regression threshold of ${regressionThreshold}ms\n`
    );
  }
}

/**
 * Generate the summary section for the results.
 *
 * For each phase, color the significance appropriately by the HL estimated difference. Red for regression, green for
 * improvement. Color with monotone if not significant.
 *
 * @param cli - This is expected to be a "compare" Command instance
 * @param phaseResultsFormatted - Array of results from calling formatPhaseData
 */
export function outputSummaryReport(
  cli: Command,
  phaseResultsFormatted: Array<
    Pick<HTMLSectionRenderData, 'phase' | 'hlDiff' | 'isSignificant'>
  >
) {
  cli.log(
    chalk.bgWhiteBright(
      chalkScheme.tbBranding.dkBlue(
        '\n    =========== Benchmark Results Summary ===========    '
      )
    )
  );
  cli.log(
    `${chalk.red('Red')} color means there was a regression. ${chalk.green(
      'Green'
    )} color means there was an improvement. You can view more statistical details about the phases above.\n`
  );
  phaseResultsFormatted.forEach(phaseData => {
    const { phase, hlDiff, isSignificant } = phaseData;
    let msg = `${chalk.bold(phase)} phase has `;

    if (isSignificant) {
      let coloredDiff;

      msg += 'an estimated difference of ';

      if (hlDiff < 0) {
        coloredDiff = chalk.red(`+${Math.abs(hlDiff)}ms`);
      } else {
        coloredDiff = chalk.green(`-${Math.abs(hlDiff)}ms`);
      }

      msg += `${coloredDiff}`;
    } else {
      msg += `${chalk.grey('no difference')}`;
    }

    msg += '. \n';
    cli.log(msg);
  });
}

/**
 * Return the trimmed compare results in JSON format
 *
 * This is propogated as the default return all the way up to the Compare command directly
 * without the need for the legacy --json flag
 *
 * @param benchmarkTableData - ICompareJSONResult[] from instantiated TBTable#getData() for the top level duration
 * @param phaseTableData - ICompareJSONResult[] from instantiated TBTable#getData() for all sub phases of the top level duration
 * @param areResultsSignificant - A culled boolean if any results are significant this is truthy
 * @param isBelowRegressionThreshold - A culled boolean to check if all results are below the config regression threshold
 * @return jsonResults - A JSON.stringified return of the trimmed compare results
 */
export function outputJSONResults(
  benchmarkTableData: ICompareJSONResult[],
  phaseTableData: ICompareJSONResult[],
  areResultsSignificant: boolean,
  isBelowRegressionThreshold: boolean
): string {
  const jsonResults: ICompareJSONResults = {
    benchmarkTableData,
    phaseTableData,
    areResultsSignificant,
    isBelowRegressionThreshold,
  };
  return JSON.stringify(jsonResults);
}

/**
 * Collect and analyze the data for the different phases for the experiment and control set and output the result to the console.
 *
 * @param results - This is expected to be generated from tracerbench core's runner. Containing the dataset for experiment and control
 * @param flags - This is expected to be CLI flags from the "compare" command
 * @param cli - This is expected to be a "compare" Command instance
 */
export function logCompareResults(
  results: ITracerBenchTraceResult[],
  flags: Pick<ICompareFlags, 'fidelity'>,
  cli: Command
): string {
  const { fidelity } = flags;
  const benchmarkTable = new TBTable('Initial Render');
  const phaseTable = new TBTable('Sub Phase of Duration');

  const controlData = results.find(element => {
    return element.set === 'control';
  }) as ITracerBenchTraceResult;

  const experimentData = results.find(element => {
    return element.set === 'experiment';
  }) as ITracerBenchTraceResult;

  const valuesByPhaseControl = bucketPhaseValues(controlData.samples);
  const valuesByPhaseExperiment = bucketPhaseValues(experimentData.samples);

  const subPhases = Object.keys(valuesByPhaseControl).filter(
    k => k !== PAGE_LOAD_TIME
  );
  const phaseResultsFormatted: Array<
    Pick<HTMLSectionRenderData, 'phase' | 'hlDiff' | 'isSignificant'>
  > = [];

  const durationStats = new Stats({
    control: valuesByPhaseControl.duration,
    experiment: valuesByPhaseExperiment.duration,
    name: 'duration',
  });
  benchmarkTable.display.push(durationStats);
  // @ts-ignore
  phaseResultsFormatted.push(
    formatPhaseData(
      valuesByPhaseControl[PAGE_LOAD_TIME],
      valuesByPhaseExperiment[PAGE_LOAD_TIME],
      PAGE_LOAD_TIME
    )
  );

  subPhases.forEach(phase => {
    phaseTable.display.push(
      new Stats({
        control: valuesByPhaseControl[phase],
        experiment: valuesByPhaseExperiment[phase],
        name: phase,
      })
    );
    // @ts-ignore
    phaseResultsFormatted.push(
      formatPhaseData(
        valuesByPhaseControl[phase],
        valuesByPhaseExperiment[phase],
        phase
      )
    );
  });

  let isBelowRegressionThreshold: boolean = true;
  const benchmarkTableData = benchmarkTable.getData();
  const phaseTableData = phaseTable.getData();
  const areResultsSignificant = anyResultsSignificant(
    fidelity as number,
    benchmarkTable.isSigArray,
    phaseTable.isSigArray
  );
  if (areResultsSignificant) {
    isBelowRegressionThreshold = allBelowRegressionThreshold(
      fidelity as number,
      benchmarkTable.estimatorDeltas,
      phaseTable.estimatorDeltas
    );
  }

  cli.log(`\n\n${benchmarkTable.render()}`);
  cli.log(`\n\n${phaseTable.render()}`);

  outputRunMetaMessagesAndWarnings(cli, flags, isBelowRegressionThreshold);
  outputSummaryReport(cli, phaseResultsFormatted);

  return outputJSONResults(
    benchmarkTableData,
    phaseTableData,
    areResultsSignificant,
    isBelowRegressionThreshold
  );
}
