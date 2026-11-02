import { describe, expect, it } from '@jest/globals';
import { render, screen } from '@testing-library/react-native';

import { DivergingBar } from '../DivergingBar';

describe('#14 The performance chart correctly displays positive, negative, and zero values', () => {
  it('positive: fills to the right (ahead) with a signed value and spoken label', async () => {
    await render(<DivergingBar advantage={12} scale={20} kind="ghost" />);
    expect(screen.getByTestId('bar-fill-ahead')).toBeTruthy();
    expect(screen.queryByTestId('bar-fill-behind')).toBeNull();
    expect(screen.getByText('+00:12')).toBeTruthy();
    expect(screen.getByLabelText('12 seconds ahead of ghost')).toBeTruthy();
    expect(screen.getByTestId('bar-zero')).toBeTruthy();
  });

  it('negative: fills to the left (behind)', async () => {
    await render(<DivergingBar advantage={-12} scale={20} kind="baseline" />);
    expect(screen.getByTestId('bar-fill-behind')).toBeTruthy();
    expect(screen.queryByTestId('bar-fill-ahead')).toBeNull();
    expect(screen.getByText('−00:12')).toBeTruthy();
    expect(screen.getByLabelText('12 seconds behind baseline')).toBeTruthy();
  });

  it('zero: no fill, zero line visible, on target', async () => {
    await render(<DivergingBar advantage={0} scale={20} kind="ghost" />);
    expect(screen.queryByTestId('bar-fill-ahead')).toBeNull();
    expect(screen.queryByTestId('bar-fill-behind')).toBeNull();
    expect(screen.getByTestId('bar-zero')).toBeTruthy();
    expect(screen.getByText('00:00')).toBeTruthy();
    expect(screen.getByLabelText('on target with ghost')).toBeTruthy();
  });

  it('no reading yet: zero line only and a dash', async () => {
    await render(<DivergingBar advantage={null} scale={10} kind="ghost" />);
    expect(screen.getByTestId('bar-zero')).toBeTruthy();
    expect(screen.queryByTestId('bar-fill-ahead')).toBeNull();
    expect(screen.getByText('—')).toBeTruthy();
    expect(screen.getByLabelText('No comparison with ghost yet')).toBeTruthy();
  });

  it('a minute or more is spoken in minutes and seconds', async () => {
    await render(<DivergingBar advantage={-65} scale={120} kind="ghost" />);
    expect(screen.getByLabelText('1 minute 5 seconds behind ghost')).toBeTruthy();
    expect(screen.getByText('±2 min')).toBeTruthy();
  });
});
