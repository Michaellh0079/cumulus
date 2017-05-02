const React = require('react');
const { List } = require('immutable');
const { connect } = require('react-redux');
const functional = require('react-functional');
const ws = require('../../reducers/workflow-status');
const Icon = require('../icon');

const JsTimeAgo = require('javascript-time-ago');
JsTimeAgo.locale(require('javascript-time-ago/locales/en'));
const timeAgo = new JsTimeAgo('en-US');

const SuccessIcon = () => <Icon className="fa-check-circle icon-success" />;
const FailedIcon = () => <Icon className="fa-exclamation-triangle icon-alert" />;
const NotRunIcon = () => <Icon className="fa-circle-o icon-disabled" />;

/**
 * Returns a human readable time for when the last execution completed for the workflow.
 */
const lastCompleted = (workflow) => {
  const lastExecution = ws.getLastCompleted(workflow);
  if (lastExecution) {
    const icon = lastExecution.get('status') === 'SUCCEEDED' ? <SuccessIcon /> : <FailedIcon />;
    return <span>{icon}{timeAgo.format(lastExecution.get('stop_date'))}</span>;
  }
  return <span><NotRunIcon />not yet</span>;
};

/**
 * Returns the success ratio with any non running executions.
 */
const successRatio = (workflow) => {
  const { numSuccessful, numExecutions } = ws.getSuccessRate(workflow);
  return `${numSuccessful} of the last ${numExecutions} successful`;
};

/**
 * Return the number of running executions for display.
 */
const runningStatus = (workflow) => {
  const numRunning = ws.getNumRunning(workflow);
  return `${numRunning} Running`;
};


/**
 * Shows a loading icon while props.isLoading. Once loading is complete the children are shown.
 */
const Loading = (props) => {
  if (props.isLoading()) {
    return <Icon className="fa-circle-o-notch fa-spin fa-2x fa-fw" />;
  }

  return props.children;
};

/**
 * TODO
 */
const WorkflowTbody = ({ workflow }) =>
  <tbody key={workflow.get('name')} className="workflow-body">
    <tr>
      <td>{workflow.get('name')}</td>
      <td>{lastCompleted(workflow)}</td>
      <td />
      <td>{successRatio(workflow)}</td>
      <td>{runningStatus(workflow)}</td>
      <td />
    </tr>
  </tbody>;

/**
 * TODO
 */
const ProductTbody = ({ workflow }) =>
  <tbody key={`${workflow.get('name')}-products`} className="product-body">
    <tr>
      <td>VIIRS_SNPP_CorrectedReflectance_TrueColor_v1_NRT (VNGCR_LQD_C1)</td>
      <td>
        <i className="icon fa fa-check-circle icon-success" aria-hidden="true" />
        XX minutes ago
      </td>
      <td>X hours ago</td>
      <td>XX of the last XX successful</td>
      <td>X Running</td>
      <td>chart.js chart here</td>
    </tr>
    <tr>
      <td>VIIRS_SNPP_CorrectedReflectance_TrueColor_v1_NRT (VNGCR_SQD_C1)</td>
      <td>
        <i className="icon fa fa-check-circle icon-success" aria-hidden="true" />
        XX minutes ago
      </td>
      <td>X hours ago</td>
      <td>XX of the last XX successful</td>
      <td>X Running</td>
      <td>chart.js chart here</td>
    </tr>
    <tr>
      <td>VIIRS_SNPP_CorrectedReflectance_TrueColor_v1_NRT (VNGCR_NQD_C1)</td>
      <td>
        <i className="icon fa fa-check-circle icon-success" aria-hidden="true" />
        XX minutes ago
      </td>
      <td>X hours ago</td>
      <td>XX of the last XX successful</td>
      <td>X Running</td>
      <td>chart.js chart here</td>
    </tr>
  </tbody>;

/**
 * Returns the icon indicating the direction of the sort on the column.
 */
const SortIcon = ({ isSorted, sortDirectionAsc }) => {
  if (isSorted) {
    if (sortDirectionAsc) {
      return <Icon className="icon-sort fa-sort-down" />;
    }
    return <Icon className="icon-sort fa-sort-up" />;
  }
  return <Icon className="icon-sort fa-sort" />;
};


/**
 * TODO
 */
const Th = (props) => {
  if (props.sortHandler) {
    return (
      <th>
        <a
          role="button" href="/" onClick={(e) => {
            e.preventDefault();
            props.sortHandler();
          }}
        >
          {props.title}
          <SortIcon isSorted={props.isSorted} sortDirectionAsc={props.sortDirectionAsc} />
        </a>
      </th>
    );
  }
  // No sorting needed
  return <th>{props.title}</th>;
};


/**
 * Creates a table containing all of the workflows configured in the system with their current
 * status.
 */
const WorkflowStatusTableFn = (props) => {
  const dispatch = props.dispatch;
  const sort = props.workflowStatus.get('sort');
  const workflows = props.workflowStatus.get('workflows') || List();
  return (
    <div>
      <h2>Workflow Status</h2>
      <Loading isLoading={() => !props.workflowStatus.get('workflows')}>
        <table
          className="workflow-status-table"
        >
          <thead>
            <tr>
              <Th
                title="Name"
                isSorted={sort.get('field') === ws.SORT_NAME}
                sortDirectionAsc={sort.get('ascending')}
                sortHandler={_ => dispatch(ws.changeSort(ws.SORT_NAME))}
              />
              <Th
                title="Last Completed"
                isSorted={sort.get('field') === ws.SORT_LAST_COMPLETED}
                sortDirectionAsc={sort.get('ascending')}
                sortHandler={_ => dispatch(ws.changeSort(ws.SORT_LAST_COMPLETED))}
              />
              <Th
                title="Most Recent Temporal Date"
                isSorted={sort.get('field') === ws.SORT_RECENT_TEMPORAL}
                sortDirectionAsc={sort.get('ascending')}
                sortHandler={_ => dispatch(ws.changeSort(ws.SORT_RECENT_TEMPORAL))}
              />
              <Th
                title="Recent Run Success Ratio"
                isSorted={sort.get('field') === ws.SORT_SUCCESS_RATE}
                sortDirectionAsc={sort.get('ascending')}
                sortHandler={_ => dispatch(ws.changeSort(ws.SORT_SUCCESS_RATE))}
              />
              <Th
                title="Status"
                isSorted={sort.get('field') === ws.SORT_NUM_RUNNING}
                sortDirectionAsc={sort.get('ascending')}
                sortHandler={_ => dispatch(ws.changeSort(ws.SORT_NUM_RUNNING))}
              />
              <Th title="Ingest Performance" />
            </tr>
          </thead>
          {workflows.map(w =>
            [<WorkflowTbody workflow={w} />, <ProductTbody workflow={w} />]
          )}

        </table>
      </Loading>
    </div>
  );
};

/**
 * @returns The properties to send to the WorkflowStatusTable component
 */
const workflowStatusStateToProps = ({ config, workflowStatus }) => ({ config, workflowStatus });

/**
 * Handles the alert list being mounted by initiating a check to get the API health
 */
const workflowStatusMount = ({ config, dispatch }) => ws.fetchWorkflowStatus(config, dispatch);

const WorkflowStatusTable = connect(workflowStatusStateToProps)(
  // Adds in the workflowStatusMount as a callback when the WorkflowStatusTable is mounted in React.
  functional(WorkflowStatusTableFn, { componentWillMount: workflowStatusMount }));

module.exports = { WorkflowStatusTable,
  // For Testing
  lastCompleted,
  successRatio,
  runningStatus,
  SuccessIcon,
  FailedIcon,
  NotRunIcon };
